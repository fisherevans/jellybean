// Package jellyfin is a typed client for the small set of Jellyfin endpoints
// Jellybean needs. It is intentionally hand-rolled rather than generated from
// OpenAPI: the surface is small and we want it understandable.
//
// The Client struct holds a service-account API key used for backend reads.
// User-credential flows (AuthenticateByName) bypass the service key.
package jellyfin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	clientName    = "Jellybean"
	clientVersion = "0.1.0"
)

// Client speaks Jellyfin's HTTP API. M1 ships only SystemInfo so the server
// can verify connectivity and version on startup; #2 fleshes out the rest.
type Client struct {
	baseURL string
	// publicURL is the client-facing origin used only when building stream
	// URLs handed back to the browser (HLS master.m3u8, transcoding URLs).
	// All server-to-Jellyfin API calls use baseURL. Defaults to baseURL;
	// override with WithPublicURL.
	publicURL  string
	apiKey     string
	httpClient *http.Client
}

// Option configures a Client at construction.
type Option func(*Client)

// WithPublicURL sets the client-facing base URL used when building stream
// URLs returned to the browser. Empty values are ignored (publicURL stays
// equal to baseURL), so an unset config yields byte-identical stream URLs.
func WithPublicURL(url string) Option {
	return func(c *Client) {
		if url != "" {
			c.publicURL = url
		}
	}
}

func New(baseURL, apiKey string, opts ...Option) *Client {
	c := &Client{
		baseURL:   baseURL,
		publicURL: baseURL,
		apiKey:    apiKey,
		// 30s is generous for normal API calls but covers cold-path
		// reconnects after laptop sleep or tunnel re-establishment.
		// Per-request contexts can shorten this where appropriate.
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// SystemInfo is the subset of /System/Info we care about. Jellyfin returns more
// fields; add here as needed.
type SystemInfo struct {
	Version       string `json:"Version"`
	ID            string `json:"Id"`
	ServerName    string `json:"ServerName"`
	OperatingSystem string `json:"OperatingSystem"`
}

// SystemInfo fetches Jellyfin's server info. Used at startup for the version
// gate and connectivity check.
func (c *Client) SystemInfo(ctx context.Context) (*SystemInfo, error) {
	req, err := c.newRequest(ctx, http.MethodGet, "/System/Info", nil)
	if err != nil {
		return nil, err
	}
	var info SystemInfo
	if err := c.do(req, &info); err != nil {
		return nil, fmt.Errorf("fetch system info: %w", err)
	}
	return &info, nil
}

// CheckVersion returns nil if the connected Jellyfin meets the minimum
// required version. Format is "10.10.X" where X is the patch.
func CheckVersion(version string) error {
	major, minor, err := parseMajorMinor(version)
	if err != nil {
		return fmt.Errorf("parse version %q: %w", version, err)
	}
	const reqMajor, reqMinor = 10, 10
	if major < reqMajor || (major == reqMajor && minor < reqMinor) {
		return fmt.Errorf("jellyfin version %s is too old; requires >= %d.%d (see docs/original-product-idea.md)", version, reqMajor, reqMinor)
	}
	return nil
}

func parseMajorMinor(v string) (int, int, error) {
	maj, rest, ok := strings.Cut(v, ".")
	if !ok {
		return 0, 0, errors.New("expected major.minor.patch")
	}
	min, _, _ := strings.Cut(rest, ".")
	majN, err := strconv.Atoi(maj)
	if err != nil {
		return 0, 0, err
	}
	minN, err := strconv.Atoi(min)
	if err != nil {
		return 0, 0, err
	}
	return majN, minN, nil
}

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	return c.newRequestWithToken(ctx, method, path, body, "")
}

// newRequestWithToken builds a request authenticated by `token` instead of
// the configured service-account key. Empty token falls back to the service
// account so existing callers keep working. Reads an optional per-request
// deviceId from the context (set by callers that have a kid device id);
// absence falls back to the default identity.
func (c *Client) newRequestWithToken(ctx context.Context, method, path string, body io.Reader, token string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	if token == "" {
		token = c.apiKey
	}
	deviceId, _ := ctx.Value(deviceIDKey{}).(string)
	req.Header.Set("Authorization", authHeader(token, deviceId))
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// deviceIDKey is the context key for the per-request DeviceId. Packages
// outside this one set it via WithDeviceID so the Jellyfin client picks
// it up automatically without threading deviceId through every method.
type deviceIDKey struct{}

// WithDeviceID returns a context that carries `id` as the DeviceId for any
// Jellyfin request made through it. Empty id is a no-op (default identity).
func WithDeviceID(ctx context.Context, id string) context.Context {
	if id == "" {
		return ctx
	}
	return context.WithValue(ctx, deviceIDKey{}, id)
}

// AuthHeaderForServiceAccount is the exported form of authHeader for callers
// outside this package (e.g. the image proxy in internal/server). Always
// includes the service-account token; uses the default device identity.
func AuthHeaderForServiceAccount(token string) string {
	return authHeader(token, "")
}

// authHeader returns the Jellyfin "MediaBrowser" auth header.
//
// `token` may be the service-account API key or a per-user access token.
// Empty token is allowed for endpoints that do not require auth (e.g.
// AuthenticateByName).
//
// `deviceId` overrides the default "jellybean-server" Device identity so
// kid TVs each appear as a distinct device in Jellyfin's session view.
// Empty falls back to the default. Device and DeviceId are required by
// some Jellyfin configurations even on the unauthenticated
// AuthenticateByName flow; sending them unconditionally is harmless.
func authHeader(token, deviceId string) string {
	device := "Jellybean Server"
	if deviceId == "" {
		deviceId = "jellybean-server"
	} else {
		device = "Jellybean Kids"
	}
	h := fmt.Sprintf(
		`MediaBrowser Client="%s", Device="%s", DeviceId="%s", Version="%s"`,
		clientName, device, deviceId, clientVersion,
	)
	if token != "" {
		h += fmt.Sprintf(`, Token="%s"`, token)
	}
	return h
}

// httpError captures non-2xx responses. The package distinguishes 401 (auth
// failure), 404 (not found), and other transport-level failures so callers
// can branch on them.
type httpError struct {
	StatusCode int
	Body       string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("jellyfin: status %d: %s", e.StatusCode, e.Body)
}

var (
	ErrUnauthorized = errors.New("jellyfin: unauthorized")
	ErrNotFound     = errors.New("jellyfin: not found")
)

// IsUnauthorized reports whether err was caused by a 401 from Jellyfin.
func IsUnauthorized(err error) bool { return errors.Is(err, ErrUnauthorized) }

// IsNotFound reports whether err was caused by a 404 from Jellyfin.
func IsNotFound(err error) bool { return errors.Is(err, ErrNotFound) }

func (c *Client) do(req *http.Request, out any) error {
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return &httpError{StatusCode: resp.StatusCode, Body: string(body)}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

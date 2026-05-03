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
	"time"
)

const (
	clientName    = "Jellybean"
	clientVersion = "0.1.0"
)

// Client speaks Jellyfin's HTTP API. M1 ships only SystemInfo so the server
// can verify connectivity and version on startup; #2 fleshes out the rest.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

func New(baseURL, apiKey string) *Client {
	return &Client{
		baseURL:    baseURL,
		apiKey:     apiKey,
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
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
	maj, rest, ok := splitOnce(v, ".")
	if !ok {
		return 0, 0, errors.New("expected major.minor.patch")
	}
	min, _, _ := splitOnce(rest, ".")
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

func splitOnce(s, sep string) (string, string, bool) {
	for i := 0; i+len(sep) <= len(s); i++ {
		if s[i:i+len(sep)] == sep {
			return s[:i], s[i+len(sep):], true
		}
	}
	return s, "", false
}

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", authHeader(c.apiKey))
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// authHeader returns the Jellyfin "MediaBrowser" auth header. Token may be the
// service-account API key or a per-user access token. Empty token is allowed
// for endpoints that do not require auth (e.g. AuthenticateByName).
func authHeader(token string) string {
	h := fmt.Sprintf(`MediaBrowser Client="%s", Version="%s"`, clientName, clientVersion)
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

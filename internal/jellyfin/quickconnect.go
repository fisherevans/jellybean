package jellyfin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// QuickConnect is Jellyfin's pairing flow: a client (no Jellyfin
// credentials yet) calls Initiate, gets a 6-digit Code + Secret. The
// user types Code into a Jellyfin client they're already logged into.
// The first client polls Connect with Secret until Authenticated flips
// true, then exchanges Secret for an AccessToken via
// AuthenticateWithQuickConnect.
//
// Why proxy through Jellybean: the user's "code your phone shows" flow
// works without ever leaking the Jellyfin host to the kid TV (so we can
// keep JELLYFIN_URL purely server-side config), and the backend can
// hold the Secret so the TV never has to handle it. The TV sees only
// {id, code} and polls our backend; the backend does the real work.

// QuickConnectResult mirrors Jellyfin's QuickConnectResult schema. We
// keep all the fields we hand back to clients (Code, expiry-related
// hints) and the Secret which stays server-side.
type QuickConnectResult struct {
	Authenticated bool      `json:"Authenticated"`
	Secret        string    `json:"Secret"`
	Code          string    `json:"Code"`
	DeviceID      string    `json:"DeviceId"`
	DeviceName    string    `json:"DeviceName"`
	AppName       string    `json:"AppName"`
	AppVersion    string    `json:"AppVersion"`
	DateAdded     time.Time `json:"DateAdded"`
}

// IsQuickConnectEnabled reports whether the Jellyfin server admin has
// turned on Quick Connect. Clients should gate their UI on this; we
// fall back to username/password when it returns false.
//
// The endpoint is unauthenticated and returns a bare boolean.
func (c *Client) IsQuickConnectEnabled(ctx context.Context) (bool, error) {
	req, err := c.newRequestWithToken(ctx, http.MethodGet, "/QuickConnect/Enabled", nil, "")
	if err != nil {
		return false, err
	}
	var enabled bool
	if err := c.do(req, &enabled); err != nil {
		return false, fmt.Errorf("quick connect enabled probe: %w", err)
	}
	return enabled, nil
}

// InitiateQuickConnect kicks off a new pairing. Jellyfin returns Code
// (6 digits, what the user types into another client) plus Secret
// (long opaque token, only the backend ever holds it). The header
// `Authorization: MediaBrowser Client=...` is required even though
// no token is - same quirk documented in CLAUDE.md for
// AuthenticateByName. newRequestWithToken("") supplies it via the
// service-account fallback path.
func (c *Client) InitiateQuickConnect(ctx context.Context) (*QuickConnectResult, error) {
	req, err := c.newRequestWithToken(ctx, http.MethodPost, "/QuickConnect/Initiate", nil, "")
	if err != nil {
		return nil, err
	}
	// Initiate is unauthenticated but the auth header doubles as our
	// device identity advertisement; AuthenticateWithQuickConnect later
	// must use the SAME DeviceId or Jellyfin rejects the exchange.
	// newRequestWithToken already pulls deviceId from the context, so
	// callers should wrap with WithDeviceID before calling.
	var out QuickConnectResult
	if err := c.do(req, &out); err != nil {
		return nil, fmt.Errorf("quick connect initiate: %w", err)
	}
	return &out, nil
}

// PollQuickConnect checks whether the user has approved a pending
// pairing. Authenticated flips true once they enter Code into another
// Jellyfin client. The endpoint is unauthenticated and idempotent;
// safe to call on a 3-5s cadence.
//
// Returns ErrNotFound when the secret has expired (Jellyfin's default
// TTL is 10 minutes) OR when the secret has already been consumed by
// a successful exchange (Jellyfin retires the secret after first
// AuthenticateWithQuickConnect success). Callers should surface "code
// expired" and offer to start over - the two cases are
// indistinguishable to the polling client.
func (c *Client) PollQuickConnect(ctx context.Context, secret string) (*QuickConnectResult, error) {
	if secret == "" {
		return nil, errors.New("secret required")
	}
	q := url.Values{}
	q.Set("secret", secret)
	req, err := c.newRequestWithToken(ctx, http.MethodGet, "/QuickConnect/Connect?"+q.Encode(), nil, "")
	if err != nil {
		return nil, err
	}
	var out QuickConnectResult
	if err := c.do(req, &out); err != nil {
		return nil, fmt.Errorf("quick connect poll: %w", err)
	}
	return &out, nil
}

// AuthenticateWithQuickConnect exchanges an approved Secret for a real
// access token. Call this only after PollQuickConnect reports
// Authenticated=true; otherwise Jellyfin returns 400 "Missing token."
//
// The DeviceId on the request must match the one used at Initiate.
// newRequestWithToken pulls it from context, so the same WithDeviceID
// wrapper that initiated the pairing should authenticate it.
func (c *Client) AuthenticateWithQuickConnect(ctx context.Context, secret string) (*AuthResult, error) {
	if secret == "" {
		return nil, errors.New("secret required")
	}
	body, err := json.Marshal(map[string]string{"Secret": secret})
	if err != nil {
		return nil, err
	}
	req, err := c.newRequestWithToken(ctx, http.MethodPost, "/Users/AuthenticateWithQuickConnect", bytes.NewReader(body), "")
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	var out AuthResult
	if err := c.do(req, &out); err != nil {
		// 400 (not 401) for "not yet authorized" - same shape as
		// AuthenticateByName's 400-for-bad-creds quirk. Map to
		// ErrUnauthorized so handlers can surface a consistent
		// "still pending" response.
		var httpErr *httpError
		if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusBadRequest {
			return nil, ErrUnauthorized
		}
		return nil, fmt.Errorf("authenticate with quick connect: %w", err)
	}
	return &out, nil
}

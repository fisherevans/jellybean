package jellyfin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// JellyfinUser is the subset of /Users fields the admin "pick a user"
// dropdown needs. We expose IsDisabled so the UI can dim disabled rows
// without filtering them out.
type JellyfinUser struct {
	ID         string `json:"Id"`
	Name       string `json:"Name"`
	IsAdmin    bool   `json:"-"`
	IsDisabled bool   `json:"-"`
}

// ListUsers returns every user Jellyfin knows about. Service-account
// scoped. Used by the admin "create kid" flow to populate the Jellyfin
// user dropdown without making the parent type a username.
func (c *Client) ListUsers(ctx context.Context) ([]JellyfinUser, error) {
	req, err := c.newRequest(ctx, http.MethodGet, "/Users", nil)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		ID     string `json:"Id"`
		Name   string `json:"Name"`
		Policy struct {
			IsAdministrator bool `json:"IsAdministrator"`
			IsDisabled      bool `json:"IsDisabled"`
		} `json:"Policy"`
	}
	if err := c.do(req, &raw); err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	out := make([]JellyfinUser, 0, len(raw))
	for _, u := range raw {
		out = append(out, JellyfinUser{
			ID:         u.ID,
			Name:       u.Name,
			IsAdmin:    u.Policy.IsAdministrator,
			IsDisabled: u.Policy.IsDisabled,
		})
	}
	return out, nil
}

// AuthenticateByName validates a user's Jellyfin credentials and returns the
// resulting access token plus user info. Used to power the parent web app
// login flow; Jellybean issues its own session afterwards.
//
// This call deliberately does NOT use the service-account API key. It uses
// the supplied username/password directly.
func (c *Client) AuthenticateByName(ctx context.Context, username, password string) (*AuthResult, error) {
	body, err := json.Marshal(map[string]string{
		"Username": username,
		"Pw":       password,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/Users/AuthenticateByName", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	// No token - this call IS the auth flow.
	deviceId, _ := ctx.Value(deviceIDKey{}).(string)
	req.Header.Set("Authorization", authHeader("", deviceId))

	var out AuthResult
	if err := c.do(req, &out); err != nil {
		// Jellyfin's AuthenticateByName returns 400 (not 401) for bad
		// credentials in some configurations; map it to ErrUnauthorized so
		// the handler can return a consistent 401.
		var httpErr *httpError
		if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusBadRequest {
			return nil, ErrUnauthorized
		}
		return nil, fmt.Errorf("authenticate %q: %w", username, err)
	}
	return &out, nil
}

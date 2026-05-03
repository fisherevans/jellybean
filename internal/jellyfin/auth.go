package jellyfin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

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
	req.Header.Set("Authorization", authHeader("")) // no token; this call IS the auth

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

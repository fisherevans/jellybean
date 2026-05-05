package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fisherevans/jellybean/internal/curation"
)

// kidOverrideRequest is a small helper that builds a kid-bearer
// request with optional override token + body.
func kidOverrideRequest(srv *Server, method, target, overrideToken string, body []byte) *httptest.ResponseRecorder {
	var bodyReader *bytes.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	var req *http.Request
	if bodyReader != nil {
		req = httptest.NewRequest(method, target, bodyReader)
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, target, nil)
	}
	req.Header.Set("Authorization", "Bearer "+testJellyfinToken)
	req.Header.Set(kidsUserIDHeader, testJellyfinUserID)
	if overrideToken != "" {
		req.Header.Set(overrideTokenHeader, overrideToken)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestOverrideVerifyPINFailWhenNotConfigured(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	body, _ := json.Marshal(map[string]string{"pin": "1234"})
	rec := kidOverrideRequest(srv, http.MethodPost, "/api/kids/override/verify-pin", "", body)
	if rec.Code != http.StatusPreconditionFailed {
		t.Errorf("verify with no PIN -> %d, want 412", rec.Code)
	}
}

func TestOverrideHappyPath(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	store := curation.NewStore(srv.db)
	// Configure a PIN.
	if err := store.SetPIN(t.Context(), "1234"); err != nil {
		t.Fatal(err)
	}

	// Verify with the right PIN -> mints session.
	body, _ := json.Marshal(map[string]string{"pin": "1234"})
	rec := kidOverrideRequest(srv, http.MethodPost, "/api/kids/override/verify-pin", "", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("verify -> %d body %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got.Token == "" || got.ExpiresAt == 0 {
		t.Fatalf("verify did not return session: %s", rec.Body.String())
	}

	// Refresh with the token bumps expiry.
	rec = kidOverrideRequest(srv, http.MethodPost, "/api/kids/override/refresh", got.Token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh -> %d body %s", rec.Code, rec.Body.String())
	}

	// Use the token to favorite an item.
	favBody, _ := json.Marshal(map[string]string{"state": "add"})
	rec = kidOverrideRequest(srv, http.MethodPost,
		"/api/kids/override/items/movie-1/favorite", got.Token, favBody)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("favorite -> %d body %s", rec.Code, rec.Body.String())
	}

	// End the session - the token no longer works.
	rec = kidOverrideRequest(srv, http.MethodPost, "/api/kids/override/end", got.Token, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("end -> %d", rec.Code)
	}
	rec = kidOverrideRequest(srv, http.MethodPost,
		"/api/kids/override/items/movie-1/favorite", got.Token, favBody)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("post-end favorite -> %d, want 401", rec.Code)
	}
}

func TestOverrideWrongPINReturns401(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	store := curation.NewStore(srv.db)
	if err := store.SetPIN(t.Context(), "1234"); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"pin": "0000"})
	rec := kidOverrideRequest(srv, http.MethodPost, "/api/kids/override/verify-pin", "", body)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong PIN -> %d, want 401", rec.Code)
	}
}

func TestOverrideMissingTokenRejected(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	body, _ := json.Marshal(map[string]string{"state": "add"})
	rec := kidOverrideRequest(srv, http.MethodPost,
		"/api/kids/override/items/foo/favorite", "", body)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("missing token -> %d, want 401", rec.Code)
	}
}

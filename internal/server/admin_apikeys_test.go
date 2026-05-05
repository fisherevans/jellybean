package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestAdminAPIKeyCRUDFlow(t *testing.T) {
	srv, store := newTestServer(t, nil)

	// Create.
	body, _ := json.Marshal(map[string]string{"name": "test-key"})
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/api-keys", bytes.NewReader(body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create -> %d body %s", rec.Code, rec.Body.String())
	}
	var created struct {
		Token string `json:"token"`
		Key   struct {
			ID int64 `json:"id"`
		} `json:"key"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Token == "" || created.Key.ID == 0 {
		t.Fatalf("create did not return token + id: %s", rec.Body.String())
	}
	if got := created.Token[:3]; got != "jb_" {
		t.Errorf("token prefix: got %q, want jb_", got)
	}

	// List.
	rec = authedRequest(t, srv, store, http.MethodGet, "/api/admin/api-keys", nil)
	var listed struct {
		Keys []struct {
			ID   int64
			Name string
		}
	}
	json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Keys) != 1 || listed.Keys[0].Name != "test-key" {
		t.Errorf("list mismatch: %+v", listed.Keys)
	}

	// Use the bearer to hit a protected endpoint - skips the cookie.
	req := httptest.NewRequest(http.MethodGet, "/api/admin/profiles", nil)
	req.Header.Set("Authorization", "Bearer "+created.Token)
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("bearer GET /api/admin/profiles -> %d body %s", rec.Code, rec.Body.String())
	}

	// Revoke.
	rec = authedRequest(t, srv, store, http.MethodPost,
		"/api/admin/api-keys/"+strconv.FormatInt(created.Key.ID, 10)+"/revoke", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke -> %d", rec.Code)
	}

	// Bearer no longer works.
	req = httptest.NewRequest(http.MethodGet, "/api/admin/profiles", nil)
	req.Header.Set("Authorization", "Bearer "+created.Token)
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("bearer post-revoke -> %d, want 401", rec.Code)
	}

	// Delete.
	rec = authedRequest(t, srv, store, http.MethodDelete,
		"/api/admin/api-keys/"+strconv.FormatInt(created.Key.ID, 10), nil)
	if rec.Code != http.StatusNoContent {
		t.Errorf("delete -> %d", rec.Code)
	}
}

func TestBearerWithBogusTokenStill401(t *testing.T) {
	srv, _ := newTestServer(t, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/admin/profiles", nil)
	req.Header.Set("Authorization", "Bearer not-a-real-token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("bogus bearer -> %d, want 401", rec.Code)
	}
}

func TestBearerLoggedInAccessLog(t *testing.T) {
	srv, store := newTestServer(t, nil)

	// Mint a key.
	body, _ := json.Marshal(map[string]string{"name": "logged"})
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/api-keys", bytes.NewReader(body))
	var created struct {
		Token string `json:"token"`
		Key   struct{ ID int64 }
	}
	json.Unmarshal(rec.Body.Bytes(), &created)

	// Use the key.
	req := httptest.NewRequest(http.MethodGet, "/api/admin/profiles", nil)
	req.Header.Set("Authorization", "Bearer "+created.Token)
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("bearer GET -> %d", rec.Code)
	}

	// Access log writes async on a goroutine. 250ms is generous;
	// real writes complete sub-millisecond on the in-memory DB.
	for i := 0; i < 25; i++ {
		time.Sleep(10 * time.Millisecond)
		rec = authedRequest(t, srv, store, http.MethodGet,
			"/api/admin/api-keys/"+strconv.FormatInt(created.Key.ID, 10)+"/log", nil)
		var listed struct {
			Entries []struct {
				Method string
				Path   string
				Status int
			}
		}
		json.Unmarshal(rec.Body.Bytes(), &listed)
		if len(listed.Entries) > 0 {
			if listed.Entries[0].Path != "/api/admin/profiles" {
				t.Errorf("logged path = %q", listed.Entries[0].Path)
			}
			if listed.Entries[0].Status != 200 {
				t.Errorf("logged status = %d", listed.Entries[0].Status)
			}
			return
		}
	}
	t.Fatal("access log entry never landed within 250ms")
}

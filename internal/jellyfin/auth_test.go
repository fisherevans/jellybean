package jellyfin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAuthenticateByName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		if r.URL.Path != "/Users/AuthenticateByName" {
			t.Errorf("path = %s", r.URL.Path)
		}
		auth := r.Header.Get("Authorization")
		if auth == "" || strings.Contains(auth, "Token=") {
			t.Errorf("auth header should not contain Token: %s", auth)
		}
		// Some Jellyfin configurations require Device and DeviceId even on
		// AuthenticateByName; verify we're sending them.
		for _, want := range []string{`Client="Jellybean"`, `Device="`, `DeviceId="`, `Version="`} {
			if !strings.Contains(auth, want) {
				t.Errorf("auth header missing %q: %s", want, auth)
			}
		}
		body, _ := io.ReadAll(r.Body)
		var payload map[string]string
		_ = json.Unmarshal(body, &payload)
		if payload["Username"] != "alice" || payload["Pw"] != "hunter2" {
			t.Errorf("unexpected payload: %v", payload)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(AuthResult{
			AccessToken: "tok",
			ServerID:    "srv",
			User:        AuthUser{ID: "u1", Name: "alice", Policy: UserPolicy{IsAdministrator: true}},
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "should-not-be-used")
	res, err := c.AuthenticateByName(context.Background(), "alice", "hunter2")
	if err != nil {
		t.Fatalf("AuthenticateByName: %v", err)
	}
	if res.AccessToken != "tok" || res.User.ID != "u1" || !res.User.Policy.IsAdministrator {
		t.Errorf("unexpected result: %+v", res)
	}
}

func TestAuthenticateByNameUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	_, err := c.AuthenticateByName(context.Background(), "alice", "wrong")
	if !IsUnauthorized(err) {
		t.Errorf("expected ErrUnauthorized, got %v", err)
	}
}

// Jellyfin can return 400 instead of 401 for bad credentials on
// AuthenticateByName; we treat that the same as an auth failure.
func TestAuthenticateByNameBadRequestIsUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("Error processing request."))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	_, err := c.AuthenticateByName(context.Background(), "alice", "wrong")
	if !IsUnauthorized(err) {
		t.Errorf("expected ErrUnauthorized for 400 response, got %v", err)
	}
}

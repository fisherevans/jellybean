package jellyfin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSystemInfo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/System/Info" {
			t.Errorf("path = %s, want /System/Info", r.URL.Path)
		}
		auth := r.Header.Get("Authorization")
		if auth == "" || !contains(auth, `Token="testkey"`) {
			t.Errorf("missing or wrong auth header: %s", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"Version":"10.10.3","Id":"abc","ServerName":"home"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "testkey")
	info, err := c.SystemInfo(context.Background())
	if err != nil {
		t.Fatalf("SystemInfo: %v", err)
	}
	if info.Version != "10.10.3" {
		t.Errorf("Version = %s", info.Version)
	}
}

func TestSystemInfoUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := New(srv.URL, "bad")
	_, err := c.SystemInfo(context.Background())
	if !IsUnauthorized(err) {
		t.Errorf("expected ErrUnauthorized, got %v", err)
	}
}

func TestCheckVersion(t *testing.T) {
	tests := []struct {
		version string
		wantErr bool
	}{
		{"10.10.0", false},
		{"10.11.5", false},
		{"11.0.0", false},
		{"10.9.99", true},
		{"10.8.0", true},
		{"9.0.0", true},
		{"garbage", true},
	}
	for _, tt := range tests {
		t.Run(tt.version, func(t *testing.T) {
			err := CheckVersion(tt.version)
			if (err != nil) != tt.wantErr {
				t.Errorf("CheckVersion(%q) = %v, wantErr = %v", tt.version, err, tt.wantErr)
			}
		})
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

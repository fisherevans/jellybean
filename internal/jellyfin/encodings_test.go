package jellyfin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStopActiveEncodingsPassesDeviceID(t *testing.T) {
	var (
		gotPath          string
		gotPlaySessionID string
		gotDeviceID      string
		gotAuth          string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("method = %s", r.Method)
		}
		gotPath = r.URL.Path
		gotPlaySessionID = r.URL.Query().Get("playSessionId")
		gotDeviceID = r.URL.Query().Get("deviceId")
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := New(srv.URL, "service-key")
	ctx := WithDeviceID(context.Background(), "tv-living-room")
	if err := c.StopActiveEncodings(ctx, "user-tok", "play-sess-1"); err != nil {
		t.Fatalf("StopActiveEncodings: %v", err)
	}

	if gotPath != "/Videos/ActiveEncodings" {
		t.Errorf("path = %q", gotPath)
	}
	if gotPlaySessionID != "play-sess-1" {
		t.Errorf("playSessionId = %q", gotPlaySessionID)
	}
	// Bug fix: Jellyfin's DELETE /Videos/ActiveEncodings 400s with
	// "deviceId field is required" if this query param is missing.
	if gotDeviceID != "tv-living-room" {
		t.Errorf("deviceId = %q, want %q", gotDeviceID, "tv-living-room")
	}
	if gotAuth == "" {
		t.Errorf("missing Authorization header")
	}
}

func TestStopActiveEncodingsFallsBackToServerDeviceID(t *testing.T) {
	var gotDeviceID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotDeviceID = r.URL.Query().Get("deviceId")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := New(srv.URL, "service-key")
	if err := c.StopActiveEncodings(context.Background(), "", "play-sess-2"); err != nil {
		t.Fatalf("StopActiveEncodings: %v", err)
	}
	if gotDeviceID != "jellybean-server" {
		t.Errorf("deviceId fallback = %q, want jellybean-server", gotDeviceID)
	}
}

func TestStopActiveEncodingsEmptySessionIsNoop(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	if err := c.StopActiveEncodings(context.Background(), "", ""); err != nil {
		t.Fatalf("StopActiveEncodings empty session: %v", err)
	}
	if called {
		t.Errorf("server was called for empty playSessionID; expected no-op")
	}
}

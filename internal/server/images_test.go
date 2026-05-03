package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// imageProxyTestServer wires up a minimal Jellybean server pointed at a
// fake Jellyfin upstream that always returns a small JPEG-ish payload
// for /Items/.../Images/.... It also tracks how many times the upstream
// was hit so we can assert that 304 short-circuits don't round-trip.
func imageProxyTestServer(t *testing.T) (*Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32

	mux := http.NewServeMux()
	mux.HandleFunc("/Items/", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "image/jpeg")
		// Set a Cache-Control on the upstream response that we expect to
		// be overwritten by Jellybean.
		w.Header().Set("Cache-Control", "public, max-age=42")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("fake-image-bytes"))
	})

	srv, _ := kidsTestServer(t, nil, nil, nil)
	// Replace the Jellyfin URL on the server's config with our image
	// upstream. kidsTestServer's fake doesn't serve /Items/{id}/Images,
	// so we point Cache-Control tests at this dedicated mux instead.
	jfImgSrv := httptest.NewServer(mux)
	t.Cleanup(jfImgSrv.Close)
	srv.cfg.JellyfinURL = jfImgSrv.URL

	return srv, &hits
}

func imageRequest(srv *Server, target string, ifNoneMatch string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Header.Set("Authorization", "Bearer "+testJellyfinToken)
	req.Header.Set(kidsUserIDHeader, testJellyfinUserID)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestImageProxyImmutableWhenTagPresent(t *testing.T) {
	srv, _ := imageProxyTestServer(t)

	rec := imageRequest(srv, "/api/kids/items/movie-1/image?tag=abc123", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	got := rec.Header().Get("Cache-Control")
	want := "public, max-age=604800, immutable"
	if got != want {
		t.Errorf("Cache-Control = %q, want %q", got, want)
	}
	if etag := rec.Header().Get("ETag"); !strings.HasPrefix(etag, `W/"`) {
		t.Errorf("ETag = %q, want weak validator", etag)
	}
}

func TestImageProxyMaxAgeWithoutTag(t *testing.T) {
	srv, _ := imageProxyTestServer(t)

	rec := imageRequest(srv, "/api/kids/items/movie-1/image", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	got := rec.Header().Get("Cache-Control")
	want := "public, max-age=86400"
	if got != want {
		t.Errorf("Cache-Control = %q, want %q", got, want)
	}
	if etag := rec.Header().Get("ETag"); !strings.HasPrefix(etag, `W/"`) {
		t.Errorf("ETag = %q, want weak validator", etag)
	}
}

func TestImageProxyIfNoneMatchRoundTrip(t *testing.T) {
	srv, hits := imageProxyTestServer(t)

	first := imageRequest(srv, "/api/kids/items/movie-1/image?tag=abc123", "")
	if first.Code != http.StatusOK {
		t.Fatalf("first: status = %d body = %s", first.Code, first.Body.String())
	}
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("first response missing ETag")
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("expected 1 upstream hit after first request, got %d", got)
	}

	second := imageRequest(srv, "/api/kids/items/movie-1/image?tag=abc123", etag)
	if second.Code != http.StatusNotModified {
		t.Fatalf("second: status = %d, want 304 body = %s", second.Code, second.Body.String())
	}
	if got := second.Header().Get("ETag"); got != etag {
		t.Errorf("304 ETag = %q, want %q", got, etag)
	}
	if got, want := second.Header().Get("Cache-Control"), "public, max-age=604800, immutable"; got != want {
		t.Errorf("304 Cache-Control = %q, want %q", got, want)
	}
	if body := second.Body.String(); body != "" {
		t.Errorf("304 body = %q, want empty", body)
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("304 should not round-trip to upstream; hits = %d, want 1", got)
	}
}

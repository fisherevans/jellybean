package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// kidLibraryRequest is like kidRequest but lets the caller attach an
// If-None-Match header. Returns the response recorder.
func kidLibraryRequest(srv *Server, target, ifNoneMatch string) *httptest.ResponseRecorder {
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

func TestKidsLibraryETagStableWhenDBUnchanged(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "a", Name: "Movie A", Type: "Movie"},
		{ID: "b", Name: "Movie B", Type: "Movie"},
	}
	srv, profileID := kidsTestServer(t, library, nil, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	store.SetState(t.Context(), "a", profileID, &visible, "admin")
	store.SetState(t.Context(), "b", profileID, &visible, "admin")

	first := kidLibraryRequest(srv, "/api/kids/library", "")
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d body = %s", first.Code, first.Body.String())
	}
	etag1 := first.Header().Get("ETag")
	if etag1 == "" {
		t.Fatalf("missing ETag on first response; headers = %v", first.Header())
	}

	second := kidLibraryRequest(srv, "/api/kids/library", "")
	if second.Code != http.StatusOK {
		t.Fatalf("second status = %d", second.Code)
	}
	etag2 := second.Header().Get("ETag")
	if etag1 != etag2 {
		t.Errorf("etag changed without DB write: %q -> %q", etag1, etag2)
	}
}

func TestKidsLibraryETagChangesOnCategorizationFlip(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "a", Name: "Movie A", Type: "Movie"},
		{ID: "b", Name: "Movie B", Type: "Movie"},
	}
	srv, profileID := kidsTestServer(t, library, nil, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	hidden := curation.StateHidden
	store.SetState(t.Context(), "a", profileID, &visible, "admin")

	first := kidLibraryRequest(srv, "/api/kids/library", "")
	etag1 := first.Header().Get("ETag")
	if etag1 == "" {
		t.Fatal("missing ETag on first response")
	}

	// Flip a categorization. ProfileMaxSetAt should advance. SetState
	// uses unixepoch() (second resolution) so back-to-back writes in
	// the same second produce the same MAX(set_at). Bump the row's
	// set_at directly to simulate a write at least one second later.
	if _, err := store.SetState(t.Context(), "b", profileID, &hidden, "admin"); err != nil {
		t.Fatalf("SetState: %v", err)
	}
	if _, err := srv.db.ExecContext(t.Context(),
		`UPDATE categorizations SET set_at = set_at + 60 WHERE jellyfin_item_id = 'b' AND profile_id = ?`,
		profileID); err != nil {
		t.Fatalf("bump set_at: %v", err)
	}

	second := kidLibraryRequest(srv, "/api/kids/library", "")
	etag2 := second.Header().Get("ETag")
	if etag2 == "" {
		t.Fatal("missing ETag on second response")
	}
	if etag1 == etag2 {
		t.Errorf("expected etag to change after SetState, got same %q", etag1)
	}
}

func TestKidsLibraryIfNoneMatchReturns304(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "a", Name: "Movie A", Type: "Movie"},
	}
	srv, profileID := kidsTestServer(t, library, nil, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	store.SetState(t.Context(), "a", profileID, &visible, "admin")

	first := kidLibraryRequest(srv, "/api/kids/library", "")
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d", first.Code)
	}
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag on first response")
	}

	second := kidLibraryRequest(srv, "/api/kids/library", etag)
	if second.Code != http.StatusNotModified {
		t.Fatalf("second status = %d, want 304", second.Code)
	}
	if body := second.Body.String(); body != "" {
		t.Errorf("304 should have empty body, got %q", body)
	}
	if got := second.Header().Get("ETag"); got != etag {
		t.Errorf("304 ETag = %q, want %q (clients update their cache from this header)", got, etag)
	}
}

// Orphan-marking removes items from the kid library without bumping
// set_at, so MaxSetAt must take MAX(orphan_at) into account too. If
// this regresses, kid clients will see stale "deleted" items in their
// IndexedDB cache until natural eviction.
func TestKidsLibraryETagChangesWhenItemOrphaned(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "a", Name: "Movie A", Type: "Movie"},
		{ID: "b", Name: "Movie B", Type: "Movie"},
	}
	srv, profileID := kidsTestServer(t, library, nil, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	store.SetState(t.Context(), "a", profileID, &visible, "admin")
	store.SetState(t.Context(), "b", profileID, &visible, "admin")

	first := kidLibraryRequest(srv, "/api/kids/library", "")
	etag1 := first.Header().Get("ETag")
	if etag1 == "" {
		t.Fatal("missing ETag on first response")
	}

	// Mark "b" orphaned (e.g. reconciler discovered Jellyfin no longer
	// has it). orphan_at should advance MaxSetAt and rotate the ETag.
	if err := store.MarkOrphan(t.Context(), "b"); err != nil {
		t.Fatalf("MarkOrphan: %v", err)
	}
	// MarkOrphan also uses unixepoch() (1s resolution); bump to be safe.
	if _, err := srv.db.ExecContext(t.Context(),
		`UPDATE categorizations SET orphan_at = orphan_at + 60 WHERE jellyfin_item_id = 'b' AND profile_id = ?`,
		profileID); err != nil {
		t.Fatalf("bump orphan_at: %v", err)
	}

	second := kidLibraryRequest(srv, "/api/kids/library", "")
	etag2 := second.Header().Get("ETag")
	if etag1 == etag2 {
		t.Errorf("expected etag to change after MarkOrphan, got same %q", etag1)
	}
}

func TestKidsLibraryStaleIfNoneMatchReturns200(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "a", Name: "Movie A", Type: "Movie"},
	}
	srv, profileID := kidsTestServer(t, library, nil, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	store.SetState(t.Context(), "a", profileID, &visible, "admin")

	stale := `W/"deadbeefdeadbeefdeadbeefdeadbeef"`
	rec := kidLibraryRequest(srv, "/api/kids/library", stale)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for stale If-None-Match", rec.Code)
	}
	got := rec.Header().Get("ETag")
	if got == "" || got == stale {
		t.Errorf("expected fresh ETag, got %q", got)
	}
}

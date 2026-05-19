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

// Two kids on the same profile see the same curation but Jellyfin's
// UserData (resume / watched / played) differs per user. The ETag has
// to scope by userId for every section, not just continue-watching, so
// kid B can't accidentally hit a cache entry produced for kid A.
func TestKidsLibraryETagScopesPerUser(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "a", Name: "Movie A", Type: "Movie"},
	}
	srv, profileID := kidsTestServer(t, library, nil, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	store.SetState(t.Context(), "a", profileID, &visible, "admin")

	tagsForUser := func(userID string) string {
		req := httptest.NewRequest(http.MethodGet, "/api/kids/library", nil)
		req.Header.Set("Authorization", "Bearer some-token")
		req.Header.Set(kidsUserIDHeader, userID)
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		return rec.Header().Get("ETag")
	}

	// First user is the test-fixture kid (mapped to profile 1). Second
	// is unmapped, which would 401 - we instead use the admin-preview
	// path with a stub session by piggybacking the same kid via the
	// curation store: create a second kid record with a different
	// jellyfin_user_id but the same profile.
	if _, err := store.CreateKid(t.Context(), curation.CreateKidParams{
		Name:           "kid-2",
		ProfileID:      profileID,
		JellyfinUserID: "kid-user-2",
	}); err != nil {
		t.Fatal(err)
	}

	etag1 := tagsForUser(testJellyfinUserID)
	etag2 := tagsForUser("kid-user-2")
	if etag1 == "" || etag2 == "" {
		t.Fatalf("missing ETag(s); got %q / %q", etag1, etag2)
	}
	if etag1 == etag2 {
		t.Errorf("expected different ETag per user, got same %q", etag1)
	}
}

// kidsBrowseRequest fires GET /api/kids/browse with optional
// If-None-Match. Mirrors kidLibraryRequest's shape so the etag tests
// stay terse.
func kidsBrowseRequest(srv *Server, ifNoneMatch string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/kids/browse", nil)
	req.Header.Set("Authorization", "Bearer "+testJellyfinToken)
	req.Header.Set(kidsUserIDHeader, testJellyfinUserID)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func kidsTagsRequest(srv *Server, ifNoneMatch string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/kids/tags", nil)
	req.Header.Set("Authorization", "Bearer "+testJellyfinToken)
	req.Header.Set(kidsUserIDHeader, testJellyfinUserID)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// TestKidsListTagsETagBumpsOnTagCreate proves the t60 invariant: a
// parent-side CreateTag mutation bumps catalog_version, so the kid's
// cached ETag on /api/kids/tags goes stale and the next request
// returns 200 instead of 304.
func TestKidsListTagsETagBumpsOnTagCreate(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	store := curation.NewStore(srv.db)

	first := kidsTagsRequest(srv, "")
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d body = %s", first.Code, first.Body.String())
	}
	etag1 := first.Header().Get("ETag")
	if etag1 == "" {
		t.Fatalf("missing ETag on first response")
	}

	// Same request, same If-None-Match -> 304 (cache still valid).
	cached := kidsTagsRequest(srv, etag1)
	if cached.Code != http.StatusNotModified {
		t.Fatalf("expected 304 before mutation, got %d", cached.Code)
	}

	// Mutate: create a tag.
	if _, err := store.CreateTag(t.Context(), curation.TagInput{Name: "Picks"}); err != nil {
		t.Fatalf("CreateTag: %v", err)
	}

	// Same If-None-Match now MUST return 200 (catalog_version bumped).
	post := kidsTagsRequest(srv, etag1)
	if post.Code != http.StatusOK {
		t.Fatalf("expected 200 after mutation, got %d", post.Code)
	}
	etag2 := post.Header().Get("ETag")
	if etag2 == "" {
		t.Fatal("missing ETag on post-mutation response")
	}
	if etag1 == etag2 {
		t.Errorf("expected ETag to rotate after CreateTag, got same %q", etag1)
	}
}

// TestKidsBrowseETagBumpsOnLayoutEdit covers the analogous flow for
// /api/kids/browse: a layout-row mutation must invalidate the kid's
// browse ETag even though it doesn't touch categorizations.
func TestKidsBrowseETagBumpsOnLayoutEdit(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	store := curation.NewStore(srv.db)

	first := kidsBrowseRequest(srv, "")
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d body = %s", first.Code, first.Body.String())
	}
	etag1 := first.Header().Get("ETag")
	if etag1 == "" {
		t.Fatalf("missing ETag on first browse response")
	}

	// Cache hit before mutation.
	cached := kidsBrowseRequest(srv, etag1)
	if cached.Code != http.StatusNotModified {
		t.Fatalf("expected 304 before mutation, got %d", cached.Code)
	}

	// Find the default layout and append a row to it.
	def, err := store.GetDefaultLayout(t.Context())
	if err != nil {
		t.Fatalf("GetDefaultLayout: %v", err)
	}
	if _, err := store.AppendRow(t.Context(), def.ID, curation.LayoutRowInput{
		Type:  curation.RowRecentlyAdded,
		Title: "What's new",
	}); err != nil {
		t.Fatalf("AppendRow: %v", err)
	}

	post := kidsBrowseRequest(srv, etag1)
	if post.Code != http.StatusOK {
		t.Fatalf("expected 200 after layout edit, got %d", post.Code)
	}
	if got := post.Header().Get("ETag"); got == "" || got == etag1 {
		t.Errorf("expected ETag to rotate after AppendRow, got %q (prev %q)", got, etag1)
	}
}

// TestKidsLibraryETagBumpsOnTagRename catches the case the original
// MaxSetAt salt missed: a tag rename touches neither categorizations
// nor orphan_at, but the kid library response shape (and indirectly
// the M6 EffectiveItemVisibility) depends on tag state, so the
// Library ETag must rotate too.
func TestKidsLibraryETagBumpsOnTagRename(t *testing.T) {
	library := []jellyfin.Item{{ID: "a", Name: "Movie A", Type: "Movie"}}
	srv, profileID := kidsTestServer(t, library, nil, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	store.SetState(t.Context(), "a", profileID, &visible, "admin")

	tag, err := store.CreateTag(t.Context(), curation.TagInput{Name: "Original"})
	if err != nil {
		t.Fatalf("CreateTag: %v", err)
	}

	first := kidLibraryRequest(srv, "/api/kids/library", "")
	etag1 := first.Header().Get("ETag")
	if etag1 == "" {
		t.Fatal("missing ETag on first response")
	}

	// Rename the tag. ProfileMaxSetAt is unchanged; catalog_version
	// bumps; ETag must rotate.
	if _, err := store.UpdateTag(t.Context(), tag.ID, curation.TagInput{Name: "Renamed"}); err != nil {
		t.Fatalf("UpdateTag: %v", err)
	}

	second := kidLibraryRequest(srv, "/api/kids/library", "")
	etag2 := second.Header().Get("ETag")
	if etag2 == "" {
		t.Fatal("missing ETag on second response")
	}
	if etag1 == etag2 {
		t.Errorf("expected Library ETag to rotate after tag rename, got same %q", etag1)
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

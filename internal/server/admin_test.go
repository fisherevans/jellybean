package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/config"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/db"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

func ageOf(n int) *int { return &n }

// makeItems builds a synthetic library of N items with monotonically
// increasing names so we can reason about Jellyfin pagination order.
func makeItems(n int) []jellyfin.Item {
	out := make([]jellyfin.Item, n)
	for i := range out {
		out[i] = jellyfin.Item{
			ID:             fmt.Sprintf("item-%04d", i),
			Name:           fmt.Sprintf("Movie %04d", i),
			Type:           "Movie",
			OfficialRating: "PG-13",
		}
	}
	return out
}

// fakeJellyfin returns an httptest.Server that serves /Items in two flavors:
//
//   - Ids=...&Recursive=...    -> filtered to the explicit IDs
//   - default                  -> recursive list with optional StartIndex / Limit
//
// Items beyond StartIndex+Limit are not returned. The total record count is
// the full library size.
func fakeJellyfin(t *testing.T, library []jellyfin.Item) *httptest.Server {
	t.Helper()
	byID := map[string]jellyfin.Item{}
	for _, it := range library {
		byID[it.ID] = it
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/System/Info", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jellyfin.SystemInfo{Version: "10.10.7"})
	})
	mux.HandleFunc("/Items", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		var items []jellyfin.Item
		if ids := q.Get("Ids"); ids != "" {
			for _, id := range strings.Split(ids, ",") {
				if it, ok := byID[id]; ok {
					items = append(items, it)
				}
			}
			json.NewEncoder(w).Encode(jellyfin.ItemsResult{
				Items:            items,
				TotalRecordCount: len(items),
			})
			return
		}
		startIndex, _ := strconv.Atoi(q.Get("StartIndex"))
		limit, _ := strconv.Atoi(q.Get("Limit"))
		if limit <= 0 {
			limit = 20
		}
		end := startIndex + limit
		if end > len(library) {
			end = len(library)
		}
		if startIndex < len(library) {
			items = library[startIndex:end]
		}
		json.NewEncoder(w).Encode(jellyfin.ItemsResult{
			Items:            items,
			TotalRecordCount: len(library),
			StartIndex:       startIndex,
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newTestServer(t *testing.T, library []jellyfin.Item) (*Server, *auth.SessionStore) {
	t.Helper()
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	jfSrv := fakeJellyfin(t, library)

	cfg := &config.Config{
		JellyfinURL:    jfSrv.URL,
		JellyfinAPIKey: "test-key",
		Port:           0,
		SessionSecret:  "test-secret",
		Env:            "dev",
	}
	srv := New(Options{
		Config:          cfg,
		Logger:          zerolog.Nop(),
		Jellyfin:        jellyfin.New(jfSrv.URL, cfg.JellyfinAPIKey),
		DB:              conn,
		JellyfinVersion: "10.10.7",
	})
	// Warm the itemcache from the fake Jellyfin so tests that hit the
	// admin items list / kid library / browse decorate paths see the
	// fixture library through the cache. Mirrors what main.go does on
	// cold boot.
	if err := srv.cache.Refresh(t.Context()); err != nil {
		t.Fatalf("itemcache refresh: %v", err)
	}
	return srv, auth.NewSessionStore(conn, cfg.SessionSecret)
}

// authedRequest runs a request through the server's router with a valid
// session cookie attached. Returns the response.
func authedRequest(t *testing.T, srv *Server, store *auth.SessionStore, method, target string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	tok, err := store.Create(t.Context(), "admin-user", "admin")
	if err != nil {
		t.Fatalf("session create: %v", err)
	}
	req := httptest.NewRequest(method, target, body)
	req.AddCookie(&http.Cookie{Name: "jellybean_session", Value: tok})
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestAdminEndpointsRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t, makeItems(10))
	for _, path := range []string{
		"/api/admin/items",
		"/api/admin/categorizations/recent",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without auth -> %d, want 401", path, rec.Code)
		}
	}
}

// defaultProfileID returns the seeded "Default" profile id from the
// in-memory DB the test server opens.
func defaultProfileID(t *testing.T, srv *Server) int64 {
	t.Helper()
	var id int64
	if err := srv.db.QueryRow(`SELECT id FROM profiles WHERE name = 'Default'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestAdminItemsFilterByUnsetForProfile(t *testing.T) {
	library := makeItems(2500)
	srv, store := newTestServer(t, library)
	profileID := defaultProfileID(t, srv)

	// Mark the first 200 items visible for the default profile; the rest
	// remain unset.
	ctx := t.Context()
	curStore := curation.NewStore(srv.db)
	visible := curation.StateVisible
	for i := 0; i < 200; i++ {
		if _, err := curStore.SetState(ctx, library[i].ID, profileID, &visible, "admin"); err != nil {
			t.Fatal(err)
		}
	}

	seen := map[string]struct{}{}
	startIdx := 0
	for {
		v := url.Values{}
		v.Set("profileId", strconv.FormatInt(profileID, 10))
		v.Set("state", "unset")
		v.Set("limit", "100")
		v.Set("startIndex", strconv.Itoa(startIdx))
		rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/items?"+v.Encode(), nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
		var resp struct {
			Items          []map[string]any
			NextStartIndex int
			HasMore        bool
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		for _, it := range resp.Items {
			id, _ := it["Id"].(string)
			if _, dup := seen[id]; dup {
				t.Fatalf("duplicate item %q across pages", id)
			}
			seen[id] = struct{}{}
		}
		if !resp.HasMore {
			break
		}
		if resp.NextStartIndex <= startIdx {
			t.Fatalf("cursor not advancing: nextStartIndex=%d startIndex=%d", resp.NextStartIndex, startIdx)
		}
		startIdx = resp.NextStartIndex
	}
	want := len(library) - 200
	if len(seen) != want {
		t.Errorf("unset count = %d, want %d (regression of the truncation bug)", len(seen), want)
	}
}

func TestAdminItemsFilterByVisibleState(t *testing.T) {
	library := makeItems(50)
	srv, store := newTestServer(t, library)
	profileID := defaultProfileID(t, srv)

	ctx := t.Context()
	curStore := curation.NewStore(srv.db)
	visible := curation.StateVisible
	for i := 0; i < 5; i++ {
		curStore.SetState(ctx, library[i].ID, profileID, &visible, "admin")
	}

	rec := authedRequest(t, srv, store, http.MethodGet,
		"/api/admin/items?profileId="+strconv.FormatInt(profileID, 10)+"&state=visible&limit=100", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var resp struct {
		Items         []map[string]any
		ReturnedCount int
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.ReturnedCount != 5 {
		t.Errorf("returned %d visible items, want 5", resp.ReturnedCount)
	}
	for _, it := range resp.Items {
		if it["State"] != "visible" {
			t.Errorf("non-visible item leaked: %v", it)
		}
	}
}

// TestAdminItemsSearchIgnoresStateFilter is the t58 regression. Before
// the fix, /api/admin/items?state=visible&search=foo hit Jellyfin live
// and then dropped rows whose categorization state didn't match the
// requested state - meaning uncategorized matches never surfaced and
// the user couldn't find them via search. The fix rewrites search to
// span all states; the state pill on each card still distinguishes
// visible / hidden / unset so the parent can see what's what.
func TestAdminItemsSearchIgnoresStateFilter(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "bobo-a", Name: "Foo Bar Apple", Type: "Movie", OfficialRating: "G"},
		{ID: "bobo-b", Name: "Foo Bar Banana", Type: "Movie", OfficialRating: "G"},
		{ID: "bobo-c", Name: "Foo Bar Cherry", Type: "Movie", OfficialRating: "G"},
		{ID: "noise", Name: "Unrelated Item", Type: "Movie", OfficialRating: "G"},
	}
	srv, store := newTestServer(t, library)
	profileID := defaultProfileID(t, srv)

	ctx := t.Context()
	visible := curation.StateVisible
	hidden := curation.StateHidden
	if _, err := srv.curation.SetState(ctx, "bobo-a", profileID, &visible, "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.curation.SetState(ctx, "bobo-b", profileID, &hidden, "admin"); err != nil {
		t.Fatal(err)
	}
	// bobo-c stays uncategorized.

	tests := []struct {
		name  string
		state string
	}{
		{"state=visible", "visible"},
		{"state=hidden", "hidden"},
		{"state=unset", "unset"},
		{"state=all", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := url.Values{}
			v.Set("profileId", strconv.FormatInt(profileID, 10))
			if tt.state != "" {
				v.Set("state", tt.state)
			}
			v.Set("search", "foo bar")
			v.Set("limit", "100")
			rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/items?"+v.Encode(), nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
			}
			var resp struct {
				Items []map[string]any
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode: %v", err)
			}
			gotStates := map[string]any{}
			for _, it := range resp.Items {
				id, _ := it["Id"].(string)
				gotStates[id] = it["State"]
			}
			if len(gotStates) != 3 {
				t.Fatalf("got %d matches, want 3 (a/b/c regardless of state): %v", len(gotStates), gotStates)
			}
			if gotStates["bobo-a"] != "visible" {
				t.Errorf("bobo-a state = %v, want visible", gotStates["bobo-a"])
			}
			if gotStates["bobo-b"] != "hidden" {
				t.Errorf("bobo-b state = %v, want hidden", gotStates["bobo-b"])
			}
			if gotStates["bobo-c"] != nil {
				t.Errorf("bobo-c state = %v, want nil (uncategorized)", gotStates["bobo-c"])
			}
			if _, leaked := gotStates["noise"]; leaked {
				t.Errorf("non-matching item leaked into search results: %v", gotStates)
			}
		})
	}
}

func TestAdminItemsRequiresProfileID(t *testing.T) {
	srv, store := newTestServer(t, makeItems(5))
	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/items", nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestAdminBulkRejectsInvalidState(t *testing.T) {
	srv, store := newTestServer(t, makeItems(10))
	profileID := defaultProfileID(t, srv)
	body := strings.NewReader(fmt.Sprintf(`{"profileId":%d,"itemIds":["item-0001"],"state":"bogus"}`, profileID))
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/items/state/bulk", body)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestAdminBulkRejectsTooMany(t *testing.T) {
	srv, store := newTestServer(t, makeItems(10))
	profileID := defaultProfileID(t, srv)
	ids := make([]string, 1001)
	for i := range ids {
		ids[i] = fmt.Sprintf("item-%04d", i)
	}
	bb, _ := json.Marshal(map[string]any{
		"profileId": profileID,
		"itemIds":   ids,
		"state":     "visible",
	})
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/items/state/bulk", strings.NewReader(string(bb)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestAdminSetStateRecordsHistoryWithSetBy(t *testing.T) {
	srv, store := newTestServer(t, makeItems(5))
	profileID := defaultProfileID(t, srv)
	body := strings.NewReader(fmt.Sprintf(`{"profileId":%d,"state":"visible"}`, profileID))
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/items/item-0000/state", body)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}

	rec = authedRequest(t, srv, store, http.MethodGet, "/api/admin/categorizations/recent", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("recent status = %d", rec.Code)
	}
	var resp struct {
		Entries []map[string]any `json:"entries"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(resp.Entries))
	}
	if resp.Entries[0]["changedBy"] != "admin-user" {
		t.Errorf("changedBy = %v, want admin-user", resp.Entries[0]["changedBy"])
	}
}

// TestRunStartupReconcileMarksOrphans covers the daemon-boot self-heal
// that fixes the "ghost tile" 404 bug: visible categorizations whose
// Jellyfin items have disappeared get tombstoned, ProfileMaxSetAt
// advances, and the kid client's next If-None-Match cycles to a fresh
// response instead of a stale 304.
func TestRunStartupReconcileMarksOrphans(t *testing.T) {
	library := makeItems(5)
	srv, _ := newTestServer(t, library)
	profileID := defaultProfileID(t, srv)
	ctx := t.Context()

	visible := curation.StateVisible
	for _, it := range library {
		if _, err := srv.curation.SetState(ctx, it.ID, profileID, &visible, "admin"); err != nil {
			t.Fatalf("SetState %s: %v", it.ID, err)
		}
	}
	// Mark a row visible for an item that doesn't exist in Jellyfin -
	// this is the "ghost" the reconciler should tombstone.
	if _, err := srv.curation.SetState(ctx, "item-deleted", profileID, &visible, "admin"); err != nil {
		t.Fatalf("SetState ghost: %v", err)
	}

	maxSetAtBefore, err := srv.curation.ProfileMaxSetAt(ctx, profileID)
	if err != nil {
		t.Fatalf("ProfileMaxSetAt before: %v", err)
	}

	// Wait long enough that unixepoch() in MarkOrphan ticks past the
	// SetState writes above. SQLite's unixepoch() is second-precision.
	time.Sleep(1100 * time.Millisecond)

	srv.RunStartupReconcile(ctx)

	maxSetAtAfter, err := srv.curation.ProfileMaxSetAt(ctx, profileID)
	if err != nil {
		t.Fatalf("ProfileMaxSetAt after: %v", err)
	}
	if maxSetAtAfter <= maxSetAtBefore {
		t.Errorf("ProfileMaxSetAt did not advance: before=%d after=%d", maxSetAtBefore, maxSetAtAfter)
	}

	visibleIDs, err := srv.curation.ListEffectivelyVisibleItemIDs(ctx, profileID)
	if err != nil {
		t.Fatalf("ListEffectivelyVisibleItemIDs: %v", err)
	}
	for _, id := range visibleIDs {
		if id == "item-deleted" {
			t.Fatalf("ghost id still visible after startup reconcile: %v", visibleIDs)
		}
	}
	if len(visibleIDs) != len(library) {
		t.Errorf("visible ids = %d, want %d (the 5 real ones)", len(visibleIDs), len(library))
	}
}


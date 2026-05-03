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

func TestAdminItemsFilterByCategoryUncategorized(t *testing.T) {
	library := makeItems(2500)
	srv, store := newTestServer(t, library)

	// Categorize the first 200 items as kid; all others stay uncategorized.
	ctx := t.Context()
	curStore := curation.NewStore(srv.db)
	for i := 0; i < 200; i++ {
		if _, err := curStore.SetAge(ctx, library[i].ID, ageOf(curation.AgeKid), "admin"); err != nil {
			t.Fatal(err)
		}
	}

	// Page through uncategorized using NextStartIndex; assert no duplicates
	// and that we eventually see items past Jellyfin index 1000 (the
	// truncation bug from the review).
	seen := map[string]struct{}{}
	startIdx := 0
	for {
		v := url.Values{}
		v.Set("category", "uncategorized")
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
		t.Errorf("uncategorized count = %d, want %d (regression of the truncation bug)", len(seen), want)
	}
}

func TestAdminItemsFilterByKid(t *testing.T) {
	library := makeItems(50)
	srv, store := newTestServer(t, library)

	ctx := t.Context()
	curStore := curation.NewStore(srv.db)
	for i := 0; i < 5; i++ {
		curStore.SetAge(ctx, library[i].ID, ageOf(curation.AgeKid), "admin")
	}

	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/items?category=kid&limit=100", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var resp struct {
		Items         []map[string]any
		ReturnedCount int
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.ReturnedCount != 5 {
		t.Errorf("returned %d kid items, want 5", resp.ReturnedCount)
	}
	for _, it := range resp.Items {
		if it["Bucket"] != "kid" {
			t.Errorf("non-kid item leaked: %v", it)
		}
	}
}

func TestAdminBulkRejectsInvalidAge(t *testing.T) {
	srv, store := newTestServer(t, makeItems(10))
	body := strings.NewReader(`{"itemIds":["item-0001"],"minAge":42}`)
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/items/age/bulk", body)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestAdminBulkRejectsTooMany(t *testing.T) {
	srv, store := newTestServer(t, makeItems(10))
	ids := make([]string, 1001)
	for i := range ids {
		ids[i] = fmt.Sprintf("item-%04d", i)
	}
	bb, _ := json.Marshal(map[string]any{"itemIds": ids, "minAge": curation.AgeKid})
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/items/age/bulk", strings.NewReader(string(bb)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestAdminSetAgeRecordsHistoryWithSetBy(t *testing.T) {
	srv, store := newTestServer(t, makeItems(5))
	body := strings.NewReader(`{"minAge":7}`)
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/items/item-0000/age", body)
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


package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/config"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/db"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// playbackHit captures one POST to a Jellyfin /Sessions/Playing* endpoint
// so tests can assert what got forwarded.
type playbackHit struct {
	Path string
	Body []byte
	Auth string
}

// kidsLibraryFakeJellyfin returns an httptest.Server that serves the
// endpoints handleKidsLibrary + handleKidsPlayback* touch. If a playback
// pointer is supplied, every /Sessions/Playing* call is recorded.
func kidsLibraryFakeJellyfin(t *testing.T, library []jellyfin.Item, resume []jellyfin.Item, playback *[]playbackHit) *httptest.Server {
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
		ids := r.URL.Query().Get("Ids")
		var items []jellyfin.Item
		if ids != "" {
			for _, id := range strings.Split(ids, ",") {
				if it, ok := byID[id]; ok {
					items = append(items, it)
				}
			}
		}
		json.NewEncoder(w).Encode(jellyfin.ItemsResult{
			Items:            items,
			TotalRecordCount: len(items),
		})
	})
	mux.HandleFunc("/Users/", func(w http.ResponseWriter, r *http.Request) {
		// Only responds to /Users/{id}/Items/Resume in this fake.
		if !strings.HasSuffix(r.URL.Path, "/Items/Resume") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(jellyfin.ItemsResult{
			Items:            resume,
			TotalRecordCount: len(resume),
		})
	})
	for _, p := range []string{"/Sessions/Playing", "/Sessions/Playing/Progress", "/Sessions/Playing/Stopped"} {
		path := p
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			if playback != nil {
				*playback = append(*playback, playbackHit{
					Path: path,
					Body: body,
					Auth: r.Header.Get("Authorization"),
				})
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// kidsTestServer spins up a Jellybean Server backed by an in-memory DB
// pre-seeded with one kid (and the Default profile). Returns the kid's
// raw API key so tests can attach it as X-Jellybean-Key. The playback
// slice (when supplied) is appended to by the fake Jellyfin on every
// /Sessions/Playing* POST.
func kidsTestServer(t *testing.T, library []jellyfin.Item, resume []jellyfin.Item, playback *[]playbackHit) (*Server, string, int64) {
	t.Helper()
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	jfSrv := kidsLibraryFakeJellyfin(t, library, resume, playback)

	cfg := &config.Config{
		JellyfinURL:    jfSrv.URL,
		JellyfinAPIKey: "service-key",
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

	store := curation.NewStore(conn)
	var defaultID int64
	if err := conn.QueryRow(`SELECT id FROM profiles WHERE name = 'Default'`).Scan(&defaultID); err != nil {
		t.Fatal(err)
	}
	res, err := store.CreateKid(t.Context(), curation.CreateKidParams{
		Name:           "test-kid",
		ProfileID:      defaultID,
		JellyfinUserID: "kid-user-1",
		JellyfinToken:  "kid-token-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	return srv, res.RawAPIKey, defaultID
}

func kidRequest(srv *Server, method, target, key string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	if key != "" {
		req.Header.Set("X-Jellybean-Key", key)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestKidsLibraryRequiresAuth(t *testing.T) {
	srv, _, _ := kidsTestServer(t, nil, nil, nil)
	rec := kidRequest(srv, http.MethodGet, "/api/kids/library", "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestKidsLibraryShowsOnlyVisible(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "a", Name: "Visible Movie", Type: "Movie"},
		{ID: "b", Name: "Hidden Movie", Type: "Movie"},
		{ID: "c", Name: "Unset Movie", Type: "Movie"},
	}
	srv, key, profileID := kidsTestServer(t, library, nil, nil)

	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	hidden := curation.StateHidden
	store.SetState(t.Context(), "a", profileID, &visible, "admin")
	store.SetState(t.Context(), "b", profileID, &hidden, "admin")
	// "c" is left unset on purpose.

	rec := kidRequest(srv, http.MethodGet, "/api/kids/library", key)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Items []jellyfin.Item
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Items) != 1 {
		t.Fatalf("returned %d items, want 1 (only the visible one)", len(resp.Items))
	}
	if resp.Items[0].ID != "a" {
		t.Errorf("got id %q, want a", resp.Items[0].ID)
	}
}

func TestKidsLibraryTypeFilter(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "m1", Name: "Movie 1", Type: "Movie"},
		{ID: "s1", Name: "Series 1", Type: "Series"},
	}
	srv, key, profileID := kidsTestServer(t, library, nil, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	store.SetState(t.Context(), "m1", profileID, &visible, "admin")
	store.SetState(t.Context(), "s1", profileID, &visible, "admin")

	cases := []struct {
		typ      string
		wantIDs  []string
	}{
		{"Movie", []string{"m1"}},
		{"Series", []string{"s1"}},
		{"Movie,Series", []string{"m1", "s1"}},
	}
	for _, tc := range cases {
		t.Run(tc.typ, func(t *testing.T) {
			rec := kidRequest(srv, http.MethodGet, "/api/kids/library?type="+tc.typ, key)
			if rec.Code != http.StatusOK {
				t.Fatalf("status %d", rec.Code)
			}
			var resp struct{ Items []jellyfin.Item }
			json.Unmarshal(rec.Body.Bytes(), &resp)
			if len(resp.Items) != len(tc.wantIDs) {
				t.Fatalf("got %d items, want %d", len(resp.Items), len(tc.wantIDs))
			}
		})
	}
}

func TestKidsLibraryContinueWatching(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "a", Name: "Visible Resume", Type: "Movie"},
		{ID: "b", Name: "Hidden Resume", Type: "Movie"},
	}
	resume := []jellyfin.Item{
		// Jellyfin returns these in resume order; both present, but only
		// "a" is visible for this kid.
		{ID: "a", Name: "Visible Resume", Type: "Movie"},
		{ID: "b", Name: "Hidden Resume", Type: "Movie"},
	}
	srv, key, profileID := kidsTestServer(t, library, resume, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	hidden := curation.StateHidden
	store.SetState(t.Context(), "a", profileID, &visible, "admin")
	store.SetState(t.Context(), "b", profileID, &hidden, "admin")

	rec := kidRequest(srv, http.MethodGet, "/api/kids/library?section=continue-watching", key)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var resp struct{ Items []jellyfin.Item }
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Items) != 1 || resp.Items[0].ID != "a" {
		t.Errorf("continue-watching returned %v, want [a]", itemIDsFromTest(resp.Items))
	}
}

func TestKidsLibraryRejectsBadSection(t *testing.T) {
	srv, key, _ := kidsTestServer(t, nil, nil, nil)
	rec := kidRequest(srv, http.MethodGet, "/api/kids/library?section=bogus", key)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestKidsPlaybackForwardsToJellyfin(t *testing.T) {
	var hits []playbackHit
	srv, key, _ := kidsTestServer(t, nil, nil, &hits)

	post := func(path, payload string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(payload))
		req.Header.Set("X-Jellybean-Key", key)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		return rec
	}

	if rec := post("/api/kids/playback/start", `{"itemId":"abc","positionTicks":0}`); rec.Code != http.StatusNoContent {
		t.Fatalf("start: status = %d body = %s", rec.Code, rec.Body.String())
	}
	if rec := post("/api/kids/playback/progress", `{"itemId":"abc","positionTicks":12345678,"isPaused":false}`); rec.Code != http.StatusNoContent {
		t.Fatalf("progress: status = %d", rec.Code)
	}
	if rec := post("/api/kids/playback/stopped", `{"itemId":"abc","positionTicks":99999999}`); rec.Code != http.StatusNoContent {
		t.Fatalf("stopped: status = %d", rec.Code)
	}

	if len(hits) != 3 {
		t.Fatalf("expected 3 jellyfin hits, got %d", len(hits))
	}
	wantPaths := []string{"/Sessions/Playing", "/Sessions/Playing/Progress", "/Sessions/Playing/Stopped"}
	for i, want := range wantPaths {
		if hits[i].Path != want {
			t.Errorf("hit[%d] path = %q, want %q", i, hits[i].Path, want)
		}
		if !strings.Contains(hits[i].Auth, `Token="kid-token-1"`) {
			t.Errorf("hit[%d] auth missing kid token: %s", i, hits[i].Auth)
		}
	}

	// Verify the wire shape Jellyfin gets: PascalCase, ItemId carries
	// through, PositionTicks is the int64 we sent.
	var progress map[string]any
	json.Unmarshal(hits[1].Body, &progress)
	if progress["ItemId"] != "abc" || progress["PositionTicks"] != float64(12345678) {
		t.Errorf("progress payload wrong: %v", progress)
	}
}

func TestKidsPlaybackRequiresAuth(t *testing.T) {
	srv, _, _ := kidsTestServer(t, nil, nil, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/kids/playback/start", strings.NewReader(`{"itemId":"abc"}`))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestKidsPlaybackRejectsMissingItemID(t *testing.T) {
	srv, key, _ := kidsTestServer(t, nil, nil, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/kids/playback/start", strings.NewReader(`{}`))
	req.Header.Set("X-Jellybean-Key", key)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

// kidsTestServer with synthetic library + an admin-path call missing
// profileId returns 400.
func TestKidsLibraryAdminMissingProfileID(t *testing.T) {
	srv, _, _ := kidsTestServer(t, nil, nil, nil)
	// Inject an admin session via the auth store.
	tok, err := makeAdminSession(t, srv)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/kids/library", nil)
	req.AddCookie(&http.Cookie{Name: "jellybean_session", Value: tok})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (missing profileId for admin path)", rec.Code)
	}
}

func itemIDsFromTest(items []jellyfin.Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}

// makeAdminSession is a tiny helper that mints a session row directly so
// kids tests can simulate the admin path without reaching for the auth
// package's full fixture set.
func makeAdminSession(t *testing.T, srv *Server) (string, error) {
	t.Helper()
	tok, err := srv.auth.Sessions.Create(t.Context(), "admin", "admin")
	if err != nil {
		return "", err
	}
	return tok, nil
}

// Static check that our test still compiles when the server adds new
// handlers; helps catch unused-test-helper warnings if test files drift.
var _ = strconv.Itoa
var _ = fmt.Sprintf

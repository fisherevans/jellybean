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

const (
	testJellyfinUserID = "kid-user-1"
	testJellyfinToken  = "kid-token-1"
)

// kidsLibraryFakeJellyfin returns an httptest.Server that serves the
// endpoints handleKidsLibrary + handleKidsPlayback* + handleKidsNextUp
// touch.
func kidsLibraryFakeJellyfin(t *testing.T, library []jellyfin.Item, resume []jellyfin.Item, playback *[]playbackHit) *httptest.Server {
	return kidsLibraryFakeJellyfinFull(t, library, resume, playback, nil, nil)
}

func kidsLibraryFakeJellyfinFull(
	t *testing.T,
	library []jellyfin.Item,
	resume []jellyfin.Item,
	playback *[]playbackHit,
	nextUp []jellyfin.Item,
	episodesBySeries map[string][]jellyfin.Item,
) *httptest.Server {
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
		if parent := r.URL.Query().Get("ParentId"); parent != "" {
			eps := episodesBySeries[parent]
			json.NewEncoder(w).Encode(jellyfin.ItemsResult{
				Items: eps, TotalRecordCount: len(eps),
			})
			return
		}
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
	mux.HandleFunc("/Shows/NextUp", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jellyfin.ItemsResult{
			Items: nextUp, TotalRecordCount: len(nextUp),
		})
	})
	// PostPlaybackInfo: just claim DirectStream is available so the
	// kids-stream handler can negotiate. URL building is exercised
	// in the jellyfin package's own tests.
	mux.HandleFunc("/Items/", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/PlaybackInfo") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		// /Items/{id}/PlaybackInfo
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 3 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		itemID := parts[1]
		json.NewEncoder(w).Encode(jellyfin.PlaybackInfoResponse{
			PlaySessionID: "test-session",
			MediaSources: []jellyfin.MediaSourceInfo{{
				ID:                   itemID,
				Container:            "mp4",
				SupportsDirectStream: true,
			}},
		})
	})
	mux.HandleFunc("/Users/", func(w http.ResponseWriter, r *http.Request) {
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
// pre-seeded with one kid (and the Default profile). Tests authenticate
// as the kid by attaching Authorization: Bearer <testJellyfinToken> +
// X-Jellyfin-User-Id: <testJellyfinUserID> headers to their requests
// (use kidRequest below).
func kidsTestServer(t *testing.T, library []jellyfin.Item, resume []jellyfin.Item, playback *[]playbackHit) (*Server, int64) {
	return kidsTestServerFull(t, library, resume, playback, nil, nil)
}

func kidsTestServerFull(
	t *testing.T,
	library []jellyfin.Item,
	resume []jellyfin.Item,
	playback *[]playbackHit,
	nextUp []jellyfin.Item,
	episodesBySeries map[string][]jellyfin.Item,
) (*Server, int64) {
	t.Helper()
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	jfSrv := kidsLibraryFakeJellyfinFull(t, library, resume, playback, nextUp, episodesBySeries)

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
	if _, err := store.CreateKid(t.Context(), curation.CreateKidParams{
		Name:           "test-kid",
		ProfileID:      defaultID,
		JellyfinUserID: testJellyfinUserID,
	}); err != nil {
		t.Fatal(err)
	}
	return srv, defaultID
}

// kidRequest builds a request authenticated as the test kid.
func kidRequest(srv *Server, method, target string, authed bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	if authed {
		req.Header.Set("Authorization", "Bearer "+testJellyfinToken)
		req.Header.Set(kidsUserIDHeader, testJellyfinUserID)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestKidsLibraryRequiresAuth(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	rec := kidRequest(srv, http.MethodGet, "/api/kids/library", false)
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
	srv, profileID := kidsTestServer(t, library, nil, nil)

	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	hidden := curation.StateHidden
	store.SetState(t.Context(), "a", profileID, &visible, "admin")
	store.SetState(t.Context(), "b", profileID, &hidden, "admin")

	rec := kidRequest(srv, http.MethodGet, "/api/kids/library", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Items []jellyfin.Item
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Items) != 1 || resp.Items[0].ID != "a" {
		t.Errorf("got %v, want [a]", itemIDsFromTest(resp.Items))
	}
}

func TestKidsLibraryTypeFilter(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "m1", Name: "Movie 1", Type: "Movie"},
		{ID: "s1", Name: "Series 1", Type: "Series"},
	}
	srv, profileID := kidsTestServer(t, library, nil, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	store.SetState(t.Context(), "m1", profileID, &visible, "admin")
	store.SetState(t.Context(), "s1", profileID, &visible, "admin")

	cases := []struct {
		typ     string
		wantIDs []string
	}{
		{"Movie", []string{"m1"}},
		{"Series", []string{"s1"}},
		{"Movie,Series", []string{"m1", "s1"}},
	}
	for _, tc := range cases {
		t.Run(tc.typ, func(t *testing.T) {
			rec := kidRequest(srv, http.MethodGet, "/api/kids/library?type="+tc.typ, true)
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
		{ID: "a", Name: "Visible Resume", Type: "Movie"},
		{ID: "b", Name: "Hidden Resume", Type: "Movie"},
	}
	srv, profileID := kidsTestServer(t, library, resume, nil)
	store := curation.NewStore(srv.db)
	visible := curation.StateVisible
	hidden := curation.StateHidden
	store.SetState(t.Context(), "a", profileID, &visible, "admin")
	store.SetState(t.Context(), "b", profileID, &hidden, "admin")

	rec := kidRequest(srv, http.MethodGet, "/api/kids/library?section=continue-watching", true)
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
	srv, _ := kidsTestServer(t, nil, nil, nil)
	rec := kidRequest(srv, http.MethodGet, "/api/kids/library?section=bogus", true)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestKidsRequestStampsDeviceID(t *testing.T) {
	var hits []playbackHit
	srv, _ := kidsTestServer(t, nil, nil, &hits)

	req := httptest.NewRequest(http.MethodPost, "/api/kids/playback/start",
		strings.NewReader(`{"itemId":"abc","positionTicks":0}`))
	req.Header.Set("Authorization", "Bearer "+testJellyfinToken)
	req.Header.Set(kidsUserIDHeader, testJellyfinUserID)
	req.Header.Set("X-Jellybean-DeviceId", "device-living-room-tv")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if len(hits) != 1 {
		t.Fatalf("expected 1 hit, got %d", len(hits))
	}
	if !strings.Contains(hits[0].Auth, `DeviceId="device-living-room-tv"`) {
		t.Errorf("DeviceId not passed through: %s", hits[0].Auth)
	}
	if !strings.Contains(hits[0].Auth, `Device="Jellybean Kids"`) {
		t.Errorf("Device should switch to 'Jellybean Kids' when a deviceId is set: %s", hits[0].Auth)
	}
}

func TestKidsRequestWithoutDeviceIDFallsBack(t *testing.T) {
	var hits []playbackHit
	srv, _ := kidsTestServer(t, nil, nil, &hits)

	req := httptest.NewRequest(http.MethodPost, "/api/kids/playback/start",
		strings.NewReader(`{"itemId":"abc"}`))
	req.Header.Set("Authorization", "Bearer "+testJellyfinToken)
	req.Header.Set(kidsUserIDHeader, testJellyfinUserID)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if !strings.Contains(hits[0].Auth, `DeviceId="jellybean-server"`) {
		t.Errorf("expected fallback DeviceId, got: %s", hits[0].Auth)
	}
}

func TestKidsPlaybackForwardsToJellyfin(t *testing.T) {
	var hits []playbackHit
	srv, _ := kidsTestServer(t, nil, nil, &hits)

	post := func(path, payload string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+testJellyfinToken)
		req.Header.Set(kidsUserIDHeader, testJellyfinUserID)
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
		if !strings.Contains(hits[i].Auth, `Token="`+testJellyfinToken+`"`) {
			t.Errorf("hit[%d] auth missing kid token: %s", i, hits[i].Auth)
		}
	}

	var progress map[string]any
	json.Unmarshal(hits[1].Body, &progress)
	if progress["ItemId"] != "abc" || progress["PositionTicks"] != float64(12345678) {
		t.Errorf("progress payload wrong: %v", progress)
	}
}

func TestKidsPlaybackRequiresAuth(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/kids/playback/start", strings.NewReader(`{"itemId":"abc"}`))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestKidsPlaybackRejectsMissingItemID(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/kids/playback/start", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+testJellyfinToken)
	req.Header.Set(kidsUserIDHeader, testJellyfinUserID)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

// Admin path: a logged-in admin session can hit /api/kids/* but must
// supply ?profileId since the cookie isn't kid-scoped.
func TestKidsLibraryAdminMissingProfileID(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
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

// A bearer token whose user id has no matching kid in Jellybean → 401.
func TestKidsAuthRejectsUnknownUser(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/kids/library", nil)
	req.Header.Set("Authorization", "Bearer some-token")
	req.Header.Set(kidsUserIDHeader, "user-not-mapped")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func itemIDsFromTest(items []jellyfin.Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}

func makeAdminSession(t *testing.T, srv *Server) (string, error) {
	t.Helper()
	tok, err := srv.auth.Sessions.Create(t.Context(), "admin", "admin")
	if err != nil {
		return "", err
	}
	return tok, nil
}

func TestKidsStreamReturnsItemTypeAndUserData(t *testing.T) {
	library := []jellyfin.Item{
		{
			ID: "movie-1", Name: "Some Movie", Type: "Movie",
			UserData: &jellyfin.ItemUserData{PlaybackPositionTicks: 600 * 10_000_000},
		},
	}
	srv, _ := kidsTestServer(t, library, nil, nil)

	rec := kidRequest(srv, http.MethodGet, "/api/kids/items/movie-1/stream", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		ItemType string                 `json:"itemType"`
		UserData *jellyfin.ItemUserData `json:"userData"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.ItemType != "Movie" {
		t.Errorf("itemType = %q, want Movie", resp.ItemType)
	}
	if resp.UserData == nil || resp.UserData.PlaybackPositionTicks != 600*10_000_000 {
		t.Errorf("userData not surfaced: %+v", resp.UserData)
	}
}

func TestKidsNextUpReturnsEpisode(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "series-1", Name: "Some Show", Type: "Series"},
	}
	nextUp := []jellyfin.Item{
		{
			ID: "ep-3", Name: "S1E3", Type: "Episode",
			SeriesID: "series-1", SeriesName: "Some Show",
			UserData: &jellyfin.ItemUserData{PlaybackPositionTicks: 0},
		},
	}
	srv, _ := kidsTestServerFull(t, library, nil, nil, nextUp, nil)

	rec := kidRequest(srv, http.MethodGet, "/api/kids/items/series-1/next-up", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		EpisodeID  string `json:"episodeId"`
		Name       string `json:"name"`
		SeriesName string `json:"seriesName"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.EpisodeID != "ep-3" || resp.Name != "S1E3" || resp.SeriesName != "Some Show" {
		t.Errorf("unexpected next-up payload: %+v", resp)
	}
}

func TestKidsNextUpFallsBackToFirstEpisode(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "series-2", Name: "Pristine Show", Type: "Series"},
	}
	episodesBySeries := map[string][]jellyfin.Item{
		"series-2": {
			{ID: "ep-1", Name: "Pilot", Type: "Episode", SeriesID: "series-2", SeriesName: "Pristine Show"},
		},
	}
	srv, _ := kidsTestServerFull(t, library, nil, nil, nil, episodesBySeries)

	rec := kidRequest(srv, http.MethodGet, "/api/kids/items/series-2/next-up", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		EpisodeID string `json:"episodeId"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.EpisodeID != "ep-1" {
		t.Errorf("got episode %q, want ep-1 (fallback)", resp.EpisodeID)
	}
}

func TestKidsNextUpRejectsAdminPath(t *testing.T) {
	srv, _ := kidsTestServer(t, nil, nil, nil)
	tok, err := makeAdminSession(t, srv)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/kids/items/series-1/next-up", nil)
	req.AddCookie(&http.Cookie{Name: "jellybean_session", Value: tok})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (admin lacks per-user token)", rec.Code)
	}
}

var _ = strconv.Itoa
var _ = fmt.Sprintf

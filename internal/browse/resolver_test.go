package browse

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/db"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// ResumeIDsForCuration is the small helper that turns Jellyfin's
// resume response (per-episode positions) into the curation-addressable
// id list. We test it directly because the bug it fixes (Continue
// Watching empty for series watchers) is purely about this rewrite.
func TestResumeIDsForCuration(t *testing.T) {
	tests := []struct {
		name string
		in   []jellyfin.Item
		want []string
	}{
		{
			name: "empty input returns empty",
			in:   nil,
			want: []string{},
		},
		{
			name: "movies pass through unchanged",
			in: []jellyfin.Item{
				{ID: "m1", Type: "Movie"},
				{ID: "m2", Type: "Movie"},
			},
			want: []string{"m1", "m2"},
		},
		{
			name: "episodes rewrite to series, preserving resume order",
			in: []jellyfin.Item{
				{ID: "ep1", Type: "Episode", SeriesID: "s-care-bears"},
				{ID: "ep2", Type: "Episode", SeriesID: "s-barney"},
			},
			want: []string{"s-care-bears", "s-barney"},
		},
		{
			name: "duplicate series collapses to first occurrence",
			in: []jellyfin.Item{
				{ID: "ep1", Type: "Episode", SeriesID: "s-care-bears"},
				{ID: "ep2", Type: "Episode", SeriesID: "s-care-bears"},
				{ID: "ep3", Type: "Episode", SeriesID: "s-care-bears"},
			},
			want: []string{"s-care-bears"},
		},
		{
			name: "movie + episode interleaved keep order",
			in: []jellyfin.Item{
				{ID: "movie-1", Type: "Movie"},
				{ID: "ep-a", Type: "Episode", SeriesID: "series-a"},
				{ID: "movie-2", Type: "Movie"},
				{ID: "ep-a-2", Type: "Episode", SeriesID: "series-a"}, // dedup
			},
			want: []string{"movie-1", "series-a", "movie-2"},
		},
		{
			name: "episode without SeriesID falls back to its own id",
			// Jellyfin should always populate SeriesID on episodes, but
			// don't trust the network. The fallback id is unlikely to
			// have a categorization (so it'll fail the visibility check),
			// which is the safe outcome.
			in: []jellyfin.Item{
				{ID: "ep-orphan", Type: "Episode"},
			},
			want: []string{"ep-orphan"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ResumeIDsForCuration(tc.in)
			if len(tc.want) == 0 && len(got) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

// fakeJellyfin returns a httptest server that answers Resume + NextUp
// with the supplied Item lists. Other paths fail the test - the CW
// resolver should only hit those two endpoints.
func fakeJellyfin(t *testing.T, resume, nextUp []jellyfin.Item) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/Users/u-1/Items/Resume":
			_ = json.NewEncoder(w).Encode(jellyfin.ItemsResult{Items: resume})
		case r.URL.Path == "/Shows/NextUp":
			_ = json.NewEncoder(w).Encode(jellyfin.ItemsResult{Items: nextUp})
		default:
			t.Errorf("unexpected upstream call: %s %s", r.Method, r.URL.String())
			http.NotFound(w, r)
		}
	}))
}

// resolveCWFixture wires up a real curation Store (sqlite :memory:),
// a fake Jellyfin, and runs resolveContinueWatching against the
// supplied resume + nextUp item lists. Returns the resolved id list.
// visibilityOverrides lets a test override the default-visible setting
// (e.g. to mark a series Hidden).
func resolveCWFixture(
	t *testing.T,
	resumeItems, nextUpItems []jellyfin.Item,
	visibleIDs []string,
	hiddenIDs []string,
	maxItems int,
) []string {
	t.Helper()
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	store := curation.NewStore(conn)
	var profileID int64
	if err := conn.QueryRow(`SELECT id FROM profiles WHERE name = 'Default'`).Scan(&profileID); err != nil {
		t.Fatalf("default profile: %v", err)
	}
	ctx := context.Background()
	visible := curation.StateVisible
	hidden := curation.StateHidden
	for _, id := range visibleIDs {
		if _, err := store.SetState(ctx, id, profileID, &visible, "test"); err != nil {
			t.Fatalf("SetState visible %s: %v", id, err)
		}
	}
	for _, id := range hiddenIDs {
		if _, err := store.SetState(ctx, id, profileID, &hidden, "test"); err != nil {
			t.Fatalf("SetState hidden %s: %v", id, err)
		}
	}
	srv := fakeJellyfin(t, resumeItems, nextUpItems)
	t.Cleanup(srv.Close)
	jc := jellyfin.New(srv.URL, "service-key")

	bc := &resolveCtx{
		store:   store,
		jelly:   jc,
		ctx:     ctx,
		profile: curation.Profile{ID: profileID, Name: "Default"},
		layout:  curation.Layout{ID: 1, Name: "Default"},
		userID:  "u-1",
		userTok: "user-token",
		visible: map[string]bool{},
	}
	row := curation.LayoutRow{ID: 1, LayoutID: 1, Type: curation.RowContinueWatching}
	cfg := map[string]any{"max_items": maxItems}

	resolved, err := resolveContinueWatching(bc, row, cfg)
	if err != nil {
		t.Fatalf("resolveContinueWatching: %v", err)
	}
	if len(resolved) != 1 {
		t.Fatalf("expected 1 resolved row, got %d", len(resolved))
	}
	return resolved[0].ItemIDs
}

func episode(id, seriesID, lastPlayed string) jellyfin.Item {
	return jellyfin.Item{
		ID:       id,
		Type:     "Episode",
		SeriesID: seriesID,
		UserData: &jellyfin.ItemUserData{LastPlayedDate: lastPlayed},
	}
}

func movie(id, lastPlayed string) jellyfin.Item {
	return jellyfin.Item{
		ID:       id,
		Type:     "Movie",
		UserData: &jellyfin.ItemUserData{LastPlayedDate: lastPlayed},
	}
}

// TestContinueWatchingMergesResumeAndNextUp covers the M-CW change:
// CW should union Resume + NextUp by series, dedupe, sort by recency,
// drop hidden series, and respect max_items.
func TestContinueWatchingMergesResumeAndNextUp(t *testing.T) {
	t.Run("union of resume and nextup, sorted by last played desc", func(t *testing.T) {
		// Resume: episodes for series A (newest) and series B (oldest).
		// NextUp: episode for series C (middle). All three series visible.
		// Expected order: A, C, B (LastPlayedDate desc).
		resume := []jellyfin.Item{
			episode("ep-a", "s-a", "2024-05-10T12:00:00Z"),
			episode("ep-b", "s-b", "2024-04-01T08:00:00Z"),
		}
		next := []jellyfin.Item{
			episode("ep-c", "s-c", "2024-05-05T10:00:00Z"),
		}
		got := resolveCWFixture(t, resume, next, []string{"s-a", "s-b", "s-c"}, nil, 10)
		want := []string{"s-a", "s-c", "s-b"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("same series in both resume and nextup deduplicates", func(t *testing.T) {
		// Resume has the in-progress E7 of series A; NextUp returns E8 of
		// the same series. Both should collapse to a single s-a tile.
		resume := []jellyfin.Item{
			episode("ep-a-7", "s-a", "2024-05-10T12:00:00Z"),
		}
		next := []jellyfin.Item{
			// NextUp on an unwatched episode often returns empty
			// LastPlayedDate; the merged sort key should still be
			// the Resume date for the series.
			episode("ep-a-8", "s-a", ""),
		}
		got := resolveCWFixture(t, resume, next, []string{"s-a"}, nil, 10)
		want := []string{"s-a"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("movies in resume only, none in nextup, both included", func(t *testing.T) {
		// NextUp never returns Movies. The Resume movie should still
		// show up alongside any NextUp series tiles.
		resume := []jellyfin.Item{
			movie("m-toy-story", "2024-05-08T20:00:00Z"),
		}
		next := []jellyfin.Item{
			episode("ep-c", "s-c", "2024-05-05T10:00:00Z"),
		}
		got := resolveCWFixture(t, resume, next, []string{"m-toy-story", "s-c"}, nil, 10)
		want := []string{"m-toy-story", "s-c"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("hidden series from nextup is filtered out", func(t *testing.T) {
		// Series B is in NextUp but admin marked it Hidden. Should not
		// surface in CW. Series A still does.
		resume := []jellyfin.Item{
			episode("ep-a", "s-a", "2024-05-10T12:00:00Z"),
		}
		next := []jellyfin.Item{
			episode("ep-b", "s-b-hidden", "2024-05-09T10:00:00Z"),
		}
		got := resolveCWFixture(t, resume, next, []string{"s-a"}, []string{"s-b-hidden"}, 10)
		want := []string{"s-a"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})
}

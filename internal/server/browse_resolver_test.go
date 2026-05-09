package server

import (
	"reflect"
	"testing"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// resumeIDsForCuration is the small helper that turns Jellyfin's
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
			got := resumeIDsForCuration(tc.in)
			if len(tc.want) == 0 && len(got) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

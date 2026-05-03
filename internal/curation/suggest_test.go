package curation

import (
	"strings"
	"testing"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

func TestSuggest(t *testing.T) {
	tests := []struct {
		name               string
		item               jellyfin.Item
		wantBucket         string
		wantConfMin        float64
		wantReasonContains string
	}{
		{
			name:        "rated G is visible",
			item:        jellyfin.Item{OfficialRating: "G"},
			wantBucket:  "visible",
			wantConfMin: 0.9,
		},
		{
			name:        "rated TV-Y is visible",
			item:        jellyfin.Item{OfficialRating: "TV-Y"},
			wantBucket:  "visible",
			wantConfMin: 0.9,
		},
		{
			name:        "rated TV-Y7 is visible",
			item:        jellyfin.Item{OfficialRating: "TV-Y7"},
			wantBucket:  "visible",
			wantConfMin: 0.9,
		},
		{
			name:        "rated R is hidden",
			item:        jellyfin.Item{OfficialRating: "R"},
			wantBucket:  "hidden",
			wantConfMin: 0.9,
		},
		{
			name:        "rated TV-MA is hidden",
			item:        jellyfin.Item{OfficialRating: "TV-MA"},
			wantBucket:  "hidden",
			wantConfMin: 0.9,
		},
		{
			name: "Pixar studio with no rating leans visible",
			item: jellyfin.Item{
				Studios: []jellyfin.Studio{{Name: "Pixar Animation Studios"}},
			},
			wantBucket:  "visible",
			wantConfMin: 0.8,
		},
		{
			name: "PG + animation is visible",
			item: jellyfin.Item{
				OfficialRating: "PG",
				Genres:         []string{"Animation", "Comedy"},
			},
			wantBucket:  "visible",
			wantConfMin: 0.6,
		},
		{
			name: "PG-13 + animation is unsure",
			item: jellyfin.Item{
				OfficialRating: "PG-13",
				Genres:         []string{"Animation"},
			},
			wantBucket: "unsure",
		},
		{
			name: "PG-13 alone is hidden",
			item: jellyfin.Item{
				OfficialRating: "PG-13",
				Genres:         []string{"Drama"},
			},
			wantBucket:  "hidden",
			wantConfMin: 0.6,
		},
		{
			name: "PG with no other signal is unsure",
			item: jellyfin.Item{
				OfficialRating: "PG",
				Genres:         []string{"Drama"},
			},
			wantBucket: "unsure",
		},
		{
			name:       "no signals is unsure low confidence",
			item:       jellyfin.Item{},
			wantBucket: "unsure",
		},
		{
			name: "kid rating wins over kid studio",
			item: jellyfin.Item{
				OfficialRating: "G",
				Studios:        []jellyfin.Studio{{Name: "Pixar"}},
			},
			wantBucket: "visible",
		},
		{
			name: "adult rating wins over animation",
			item: jellyfin.Item{
				OfficialRating: "R",
				Genres:         []string{"Animation"},
			},
			wantBucket: "hidden",
		},
		{
			name: "kid studio + teen rating is unsure",
			item: jellyfin.Item{
				OfficialRating: "PG-13",
				Studios:        []jellyfin.Studio{{Name: "Pixar"}},
			},
			wantBucket: "unsure",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Suggest(tt.item)
			if got.Bucket != tt.wantBucket {
				t.Errorf("Bucket = %q, want %q", got.Bucket, tt.wantBucket)
			}
			if got.Confidence < tt.wantConfMin {
				t.Errorf("Confidence = %v, want >= %v", got.Confidence, tt.wantConfMin)
			}
			if tt.wantReasonContains != "" {
				ok := false
				for _, r := range got.Reasoning {
					if strings.Contains(r, tt.wantReasonContains) {
						ok = true
						break
					}
				}
				if !ok {
					t.Errorf("reasoning %v missing %q", got.Reasoning, tt.wantReasonContains)
				}
			}
		})
	}
}

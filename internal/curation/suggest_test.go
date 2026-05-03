package curation

import (
	"testing"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

func TestSuggest(t *testing.T) {
	tests := []struct {
		name       string
		item       jellyfin.Item
		wantCat    Category
		wantConfMin float64
		wantReasonContains string
	}{
		{
			name:    "rated G is kid",
			item:    jellyfin.Item{OfficialRating: "G"},
			wantCat: CategoryKid,
			wantConfMin: 0.9,
			wantReasonContains: "G",
		},
		{
			name:    "rated TV-Y is kid",
			item:    jellyfin.Item{OfficialRating: "TV-Y"},
			wantCat: CategoryKid,
			wantConfMin: 0.9,
		},
		{
			name:    "rated TV-Y7 is kid",
			item:    jellyfin.Item{OfficialRating: "TV-Y7"},
			wantCat: CategoryKid,
			wantConfMin: 0.9,
		},
		{
			name:    "rated R is adult",
			item:    jellyfin.Item{OfficialRating: "R"},
			wantCat: CategoryAdult,
			wantConfMin: 0.9,
		},
		{
			name:    "rated TV-MA is adult",
			item:    jellyfin.Item{OfficialRating: "TV-MA"},
			wantCat: CategoryAdult,
			wantConfMin: 0.9,
		},
		{
			name: "Pixar studio is kid even with no rating",
			item: jellyfin.Item{
				Studios: []jellyfin.Studio{{Name: "Pixar Animation Studios"}},
			},
			wantCat: CategoryKid,
			wantConfMin: 0.8,
			wantReasonContains: "Pixar",
		},
		{
			name: "PG + animation is kid",
			item: jellyfin.Item{
				OfficialRating: "PG",
				Genres:         []string{"Animation", "Comedy"},
			},
			wantCat: CategoryKid,
			wantConfMin: 0.65,
		},
		{
			name: "PG-13 + animation is unsure (could be anime / adult animation)",
			item: jellyfin.Item{
				OfficialRating: "PG-13",
				Genres:         []string{"Animation"},
			},
			wantCat: CategoryUnsure,
			wantConfMin: 0.4,
		},
		{
			name: "PG-13 alone leans adult",
			item: jellyfin.Item{
				OfficialRating: "PG-13",
				Genres:         []string{"Drama"},
			},
			wantCat: CategoryAdult,
			wantConfMin: 0.65,
		},
		{
			name: "TV-14 alone leans adult",
			item: jellyfin.Item{
				OfficialRating: "TV-14",
			},
			wantCat: CategoryAdult,
			wantConfMin: 0.65,
		},
		{
			name: "PG with no other signal is unsure",
			item: jellyfin.Item{
				OfficialRating: "PG",
				Genres:         []string{"Drama"},
			},
			wantCat: CategoryUnsure,
			wantConfMin: 0.4,
		},
		{
			name:    "no signals at all is unsure low confidence",
			item:    jellyfin.Item{},
			wantCat: CategoryUnsure,
			wantConfMin: 0.0, // any low number is fine
		},
		{
			name: "kid rating wins over kid studio (just confirms first-match-wins)",
			item: jellyfin.Item{
				OfficialRating: "G",
				Studios:        []jellyfin.Studio{{Name: "Pixar"}},
			},
			wantCat: CategoryKid,
			wantConfMin: 0.9,
			wantReasonContains: "G",
		},
		{
			name: "adult rating wins over animation",
			item: jellyfin.Item{
				OfficialRating: "R",
				Genres:         []string{"Animation"},
			},
			wantCat: CategoryAdult,
			wantConfMin: 0.9,
		},
		{
			name: "lowercase rating still matches",
			item: jellyfin.Item{OfficialRating: "g"},
			wantCat: CategoryKid,
			wantConfMin: 0.9,
		},
		{
			name: "studio name is case-insensitive",
			item: jellyfin.Item{
				Studios: []jellyfin.Studio{{Name: "pixar"}},
			},
			wantCat: CategoryKid,
			wantConfMin: 0.8,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Suggest(tt.item)
			if got.Category != tt.wantCat {
				t.Errorf("Category = %q, want %q", got.Category, tt.wantCat)
			}
			if got.Confidence < tt.wantConfMin {
				t.Errorf("Confidence = %v, want >= %v", got.Confidence, tt.wantConfMin)
			}
			if tt.wantReasonContains != "" {
				found := false
				for _, r := range got.Reasoning {
					if contains(r, tt.wantReasonContains) {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("reasoning %v does not contain %q", got.Reasoning, tt.wantReasonContains)
				}
			}
		})
	}
}

// local contains rather than importing strings just for tests
func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

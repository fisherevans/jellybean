package curation

import (
	"testing"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

func TestSuggest(t *testing.T) {
	tests := []struct {
		name               string
		item               jellyfin.Item
		wantBucket         string
		wantMinAge         *int  // nil = unsure
		wantConfMin        float64
		wantReasonContains string
	}{
		{
			name:        "rated G is toddler-tier kid",
			item:        jellyfin.Item{OfficialRating: "G"},
			wantBucket:  "kid",
			wantMinAge:  ageOf(AgeToddler),
			wantConfMin: 0.9,
		},
		{
			name:        "rated TV-Y is toddler kid",
			item:        jellyfin.Item{OfficialRating: "TV-Y"},
			wantBucket:  "kid",
			wantMinAge:  ageOf(AgeToddler),
			wantConfMin: 0.9,
		},
		{
			name:        "rated TV-Y7 is preschool",
			item:        jellyfin.Item{OfficialRating: "TV-Y7"},
			wantBucket:  "kid",
			wantMinAge:  ageOf(AgePreschool),
			wantConfMin: 0.9,
		},
		{
			name:        "rated R is adult",
			item:        jellyfin.Item{OfficialRating: "R"},
			wantBucket:  "adult",
			wantMinAge:  ageOf(AgeAdult),
			wantConfMin: 0.9,
		},
		{
			name:        "rated TV-MA is adult",
			item:        jellyfin.Item{OfficialRating: "TV-MA"},
			wantBucket:  "adult",
			wantMinAge:  ageOf(AgeAdult),
			wantConfMin: 0.9,
		},
		{
			name: "Pixar studio with no rating leans preschool kid",
			item: jellyfin.Item{
				Studios: []jellyfin.Studio{{Name: "Pixar Animation Studios"}},
			},
			wantBucket: "kid",
			wantMinAge: ageOf(AgePreschool),
			wantConfMin: 0.8,
		},
		{
			name: "PG + animation is younger kid",
			item: jellyfin.Item{
				OfficialRating: "PG",
				Genres:         []string{"Animation", "Comedy"},
			},
			wantBucket:  "kid",
			wantMinAge:  ageOf(AgeKid),
			wantConfMin: 0.6,
		},
		{
			name: "PG-13 + animation is unsure",
			item: jellyfin.Item{
				OfficialRating: "PG-13",
				Genres:         []string{"Animation"},
			},
			wantBucket: "unsure",
			wantMinAge: nil,
		},
		{
			name: "PG-13 alone is teen",
			item: jellyfin.Item{
				OfficialRating: "PG-13",
				Genres:         []string{"Drama"},
			},
			wantBucket: "adult",
			wantMinAge: ageOf(AgeTeen),
			wantConfMin: 0.6,
		},
		{
			name: "PG with no other signal is unsure",
			item: jellyfin.Item{
				OfficialRating: "PG",
				Genres:         []string{"Drama"},
			},
			wantBucket: "unsure",
			wantMinAge: nil,
		},
		{
			name:       "no signals is unsure low confidence",
			item:       jellyfin.Item{},
			wantBucket: "unsure",
			wantMinAge: nil,
		},
		{
			name: "kid rating wins over kid studio (toddler tier)",
			item: jellyfin.Item{
				OfficialRating: "G",
				Studios:        []jellyfin.Studio{{Name: "Pixar"}},
			},
			wantBucket: "kid",
			wantMinAge: ageOf(AgeToddler),
		},
		{
			name: "adult rating wins over animation",
			item: jellyfin.Item{
				OfficialRating: "R",
				Genres:         []string{"Animation"},
			},
			wantBucket: "adult",
			wantMinAge: ageOf(AgeAdult),
		},
		{
			name: "lowercase rating still matches",
			item: jellyfin.Item{OfficialRating: "g"},
			wantBucket: "kid",
			wantMinAge: ageOf(AgeToddler),
		},
		{
			name: "kid studio + PG nudges down to preschool",
			item: jellyfin.Item{
				OfficialRating: "PG",
				Studios:        []jellyfin.Studio{{Name: "Pixar"}},
			},
			wantBucket: "kid",
			wantMinAge: ageOf(AgePreschool),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Suggest(tt.item)
			if got.Bucket != tt.wantBucket {
				t.Errorf("Bucket = %q, want %q", got.Bucket, tt.wantBucket)
			}
			if !intPtrEqual(got.MinAge, tt.wantMinAge) {
				gotS, wantS := "nil", "nil"
				if got.MinAge != nil {
					gotS = itoa(*got.MinAge)
				}
				if tt.wantMinAge != nil {
					wantS = itoa(*tt.wantMinAge)
				}
				t.Errorf("MinAge = %s, want %s", gotS, wantS)
			}
			if got.Confidence < tt.wantConfMin {
				t.Errorf("Confidence = %v, want >= %v", got.Confidence, tt.wantConfMin)
			}
		})
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

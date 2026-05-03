package curation

import (
	"strings"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// Suggestion is the output of the auto-categorization heuristics. The parent
// confirms (or overrides) via the categorization API; suggestions never
// write to the DB on their own.
//
// Confidence is a 0..1 hint for the UI to bucket items into "high / medium /
// low" certainty groups. Reasoning is a list of human-readable strings the
// UI shows so the parent understands why the system thinks what it thinks.
type Suggestion struct {
	Category   Category `json:"category"`
	Confidence float64  `json:"confidence"`
	Reasoning  []string `json:"reasoning"`
}

// CategoryUnsure is a non-stored "I don't know" verdict. Suggestions return
// this for items the rules can't confidently bucket; it is NOT a value
// callers can pass to SetCategory (the DB CHECK rejects it).
const CategoryUnsure Category = "unsure"

// Studios that essentially guarantee kid-friendly content. Tune the list as
// the library exposes new edge cases. Comparison is case-insensitive.
var KidStudios = []string{
	"Disney",
	"Walt Disney Pictures",
	"Walt Disney Animation Studios",
	"Pixar",
	"Pixar Animation Studios",
	"Nickelodeon",
	"Nickelodeon Animation Studio",
	"Cartoon Network",
	"Cartoon Network Studios",
	"DreamWorks Animation",
	"DreamWorks Pictures",
	"Illumination",
	"Illumination Entertainment",
	"Studio Ghibli",
	"Sesame Workshop",
	"PBS Kids",
}

// Rating buckets for quick lookup. Maintained as sets so order doesn't matter
// and lookups are O(1).
var (
	kidRatings = map[string]struct{}{
		"G":      {},
		"TV-Y":   {},
		"TV-Y7":  {},
		"TV-Y7-FV": {},
		"TV-G":   {},
		"E":      {}, // some Jellyfin scrapers report "E" for educational
	}
	adultRatings = map[string]struct{}{
		"R":     {},
		"NC-17": {},
		"TV-MA": {},
		"X":     {},
	}
	mildRatings = map[string]struct{}{
		"PG":    {},
		"TV-PG": {},
	}
	teenRatings = map[string]struct{}{
		"PG-13": {},
		"TV-14": {},
	}
)

// Suggest applies the rule list (first match wins) and returns a Suggestion.
// Rules are intentionally simple: the parent makes the call, we just
// pre-sort the work.
func Suggest(item jellyfin.Item) Suggestion {
	rating := strings.ToUpper(strings.TrimSpace(item.OfficialRating))
	hasAnimation := containsFold(item.Genres, "Animation")
	kidStudio := matchKidStudio(item.Studios)

	// 1. Hard kid rating wins immediately.
	if _, ok := kidRatings[rating]; ok {
		return Suggestion{
			Category:   CategoryKid,
			Confidence: 0.95,
			Reasoning:  []string{"Rated " + rating},
		}
	}

	// 2. Hard adult rating wins immediately.
	if _, ok := adultRatings[rating]; ok {
		return Suggestion{
			Category:   CategoryAdult,
			Confidence: 0.95,
			Reasoning:  []string{"Rated " + rating},
		}
	}

	// 3. Kid studio (no contraindicating rating).
	if kidStudio != "" {
		return Suggestion{
			Category:   CategoryKid,
			Confidence: 0.85,
			Reasoning:  []string{"Studio is " + kidStudio},
		}
	}

	// 4. Animation + mild rating: lean kid.
	if hasAnimation {
		if _, ok := mildRatings[rating]; ok {
			return Suggestion{
				Category:   CategoryKid,
				Confidence: 0.7,
				Reasoning:  []string{"Animation, rated " + rating},
			}
		}
		// 5. Animation + teen rating: actually unsure (could go either way -
		// adult animated comedies, anime, etc.).
		if _, ok := teenRatings[rating]; ok {
			return Suggestion{
				Category:   CategoryUnsure,
				Confidence: 0.5,
				Reasoning:  []string{"Animation, but rated " + rating},
			}
		}
	}

	// 6. Teen rating without animation: lean adult.
	if _, ok := teenRatings[rating]; ok {
		return Suggestion{
			Category:   CategoryAdult,
			Confidence: 0.7,
			Reasoning:  []string{"Rated " + rating},
		}
	}

	// 7. Mild rating with no other signal: unsure.
	if _, ok := mildRatings[rating]; ok {
		return Suggestion{
			Category:   CategoryUnsure,
			Confidence: 0.5,
			Reasoning:  []string{"Rated " + rating + ", no other signals"},
		}
	}

	// 8. Nothing to go on.
	return Suggestion{
		Category:   CategoryUnsure,
		Confidence: 0.2,
		Reasoning:  []string{"No rating, no kid-studio match"},
	}
}

func containsFold(haystack []string, needle string) bool {
	for _, h := range haystack {
		if strings.EqualFold(h, needle) {
			return true
		}
	}
	return false
}

func matchKidStudio(studios []jellyfin.Studio) string {
	for _, s := range studios {
		for _, k := range KidStudios {
			if strings.EqualFold(s.Name, k) {
				return s.Name
			}
		}
	}
	return ""
}

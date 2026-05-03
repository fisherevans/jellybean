package curation

import (
	"strings"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// Suggestion is the auto-categorization output. The parent confirms via
// the categorization API; suggestions never write to the DB on their own.
//
// MinAge is the recommended minimum viewer age, or nil when the item is
// "unsure" (insufficient signals). Confidence is 0..1. Reasoning is the
// list of human-readable strings the UI shows so the parent understands
// why we landed where we did.
type Suggestion struct {
	MinAge     *int     `json:"minAge"` // nil = unsure
	Confidence float64  `json:"confidence"`
	Reasoning  []string `json:"reasoning"`
	// Bucket is a coarse "kid / adult / unsure" label derived from MinAge.
	// Sweep groups by Bucket; UIs that want age granularity read MinAge.
	Bucket string `json:"bucket"`
}

// suggestionFromAge wraps a min-age verdict + confidence + reasoning into
// a Suggestion with the derived bucket string filled in.
func suggestionFromAge(age int, confidence float64, reasoning ...string) Suggestion {
	a := age
	bucket := "kid"
	if age >= 13 {
		bucket = "adult"
	}
	return Suggestion{
		MinAge:     &a,
		Confidence: confidence,
		Reasoning:  reasoning,
		Bucket:     bucket,
	}
}

func suggestionUnsure(confidence float64, reasoning ...string) Suggestion {
	return Suggestion{
		MinAge:     nil,
		Confidence: confidence,
		Reasoning:  reasoning,
		Bucket:     "unsure",
	}
}

// Studios that essentially guarantee kid-friendly content. Tune as the
// library exposes new edge cases. Comparison is case-insensitive.
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

// Each rating bucket maps to an inferred minimum viewer age. The values
// are deliberately close to MPAA / TV guidance: G/TV-Y -> 2, TV-Y7/TV-G -> 5,
// PG/TV-PG -> 7, PG-13/TV-14 -> 13, R/TV-MA/NC-17 -> 18.
var (
	ratingMinAge = map[string]int{
		// Toddler / very young
		"G":     AgeToddler,
		"TV-Y":  AgeToddler,
		// Preschool / early elementary
		"TV-Y7":    AgePreschool,
		"TV-Y7-FV": AgePreschool,
		"TV-G":     AgePreschool,
		"E":        AgePreschool,
		// Younger kids
		"PG":    AgeKid,
		"TV-PG": AgeKid,
		// Teen
		"PG-13": AgeTeen,
		"TV-14": AgeTeen,
		// Adult
		"R":     AgeAdult,
		"TV-MA": AgeAdult,
		"NC-17": AgeAdult,
		"X":     AgeAdult,
	}
)

// Suggest applies the rule list (first match wins) and returns a Suggestion.
// Rules are intentionally simple: the parent makes the call, we just
// pre-sort the work.
func Suggest(item jellyfin.Item) Suggestion {
	rating := strings.ToUpper(strings.TrimSpace(item.OfficialRating))
	hasAnimation := containsFold(item.Genres, "Animation")
	kidStudio := matchKidStudio(item.Studios)

	// 1. Adult ratings always win - kid studio doesn't override an R.
	if age, ok := ratingMinAge[rating]; ok && age >= AgeAdult {
		return suggestionFromAge(age, 0.95, "Rated "+rating)
	}

	// 2. Hard kid ratings (G, TV-Y, TV-Y7, TV-G).
	if age, ok := ratingMinAge[rating]; ok && age <= AgePreschool {
		// Kid studio nudges the suggestion younger when the rating is
		// at the upper end of the kid range.
		if kidStudio != "" && age == AgePreschool {
			return suggestionFromAge(AgeToddler, 0.92, "Rated "+rating, "Studio is "+kidStudio)
		}
		return suggestionFromAge(age, 0.95, "Rated "+rating)
	}

	// 3. Kid studio with no contraindicating rating: lean kid (age 5).
	if kidStudio != "" {
		// If we also have a PG / TV-PG rating, blend that in for the age.
		if age, ok := ratingMinAge[rating]; ok && age == AgeKid {
			return suggestionFromAge(AgePreschool, 0.85, "Studio is "+kidStudio, "Rated "+rating)
		}
		// If we have a teen rating despite the kid studio, that's likely
		// adult-targeted animation; don't pretend it's kid-safe.
		if age, ok := ratingMinAge[rating]; ok && age == AgeTeen {
			return suggestionUnsure(0.5, "Kid studio ("+kidStudio+") but rated "+rating)
		}
		return suggestionFromAge(AgePreschool, 0.85, "Studio is "+kidStudio)
	}

	// 4. Animation + mild rating: lean kid.
	if hasAnimation {
		if age, ok := ratingMinAge[rating]; ok && age == AgeKid {
			return suggestionFromAge(AgeKid, 0.7, "Animation, rated "+rating)
		}
		// Animation + teen rating: could be anime / adult animation.
		if age, ok := ratingMinAge[rating]; ok && age == AgeTeen {
			return suggestionUnsure(0.5, "Animation, but rated "+rating)
		}
	}

	// 5. Teen rating without animation: lean adult side.
	if age, ok := ratingMinAge[rating]; ok && age == AgeTeen {
		return suggestionFromAge(AgeTeen, 0.7, "Rated "+rating)
	}

	// 6. Mild rating with no other signal: unsure.
	if _, ok := ratingMinAge[rating]; ok {
		return suggestionUnsure(0.5, "Rated "+rating+", no other signals")
	}

	// 7. Nothing to go on.
	return suggestionUnsure(0.2, "No rating, no kid-studio match")
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

package curation

import (
	"strings"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// Suggestion is the auto-categorization output. It is a hint for the
// curation UI; the parent confirms (or overrides) per profile via the
// categorization API.
//
// Bucket is "visible", "hidden", or "unsure". Confidence is 0..1.
// Reasoning is the list of human-readable strings the UI shows so the
// parent understands why the system landed where it did.
type Suggestion struct {
	Bucket     string   `json:"bucket"` // visible | hidden | unsure
	Confidence float64  `json:"confidence"`
	Reasoning  []string `json:"reasoning"`
}

func suggestVisible(confidence float64, reasoning ...string) Suggestion {
	return Suggestion{Bucket: "visible", Confidence: confidence, Reasoning: reasoning}
}

func suggestHidden(confidence float64, reasoning ...string) Suggestion {
	return Suggestion{Bucket: "hidden", Confidence: confidence, Reasoning: reasoning}
}

func suggestUnsure(confidence float64, reasoning ...string) Suggestion {
	return Suggestion{Bucket: "unsure", Confidence: confidence, Reasoning: reasoning}
}

// Studios that essentially guarantee kid-friendly content.
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

// Hard kid ratings: items the system is confident a parent will mark visible.
var hardKidRatings = map[string]struct{}{
	"G": {}, "TV-Y": {}, "TV-Y7": {}, "TV-Y7-FV": {}, "TV-G": {}, "E": {},
}

// Hard adult ratings: items the system is confident will be hidden from kids.
var hardAdultRatings = map[string]struct{}{
	"R": {}, "NC-17": {}, "TV-MA": {}, "X": {},
}

// Mid ratings - lean kid only with corroborating signals.
var mildRatings = map[string]struct{}{
	"PG": {}, "TV-PG": {},
}

// Teen ratings - lean adult unless animated.
var teenRatings = map[string]struct{}{
	"PG-13": {}, "TV-14": {},
}

// Suggest applies the rule list (first match wins) and returns a Suggestion.
// Rules are intentionally simple: the parent decides per profile, we just
// pre-sort the work into looks-visible / looks-hidden / needs-review.
func Suggest(item jellyfin.Item) Suggestion {
	rating := strings.ToUpper(strings.TrimSpace(item.OfficialRating))
	hasAnimation := containsFold(item.Genres, "Animation")
	kidStudio := matchKidStudio(item.Studios)

	// 1. Hard adult rating wins immediately.
	if _, ok := hardAdultRatings[rating]; ok {
		return suggestHidden(0.95, "Rated "+rating)
	}

	// 2. Hard kid rating.
	if _, ok := hardKidRatings[rating]; ok {
		return suggestVisible(0.95, "Rated "+rating)
	}

	// 3. Kid studio with no contraindicating rating.
	if kidStudio != "" {
		// Teen rating despite a kid studio: ambiguous (adult animation, anime).
		if _, ok := teenRatings[rating]; ok {
			return suggestUnsure(0.5, "Kid studio ("+kidStudio+") but rated "+rating)
		}
		return suggestVisible(0.85, "Studio is "+kidStudio)
	}

	// 4. Animation + mild rating: lean visible.
	if hasAnimation {
		if _, ok := mildRatings[rating]; ok {
			return suggestVisible(0.7, "Animation, rated "+rating)
		}
		// Animation + teen rating: could be anime / adult animation.
		if _, ok := teenRatings[rating]; ok {
			return suggestUnsure(0.5, "Animation, but rated "+rating)
		}
	}

	// 5. Teen rating without animation: lean hidden.
	if _, ok := teenRatings[rating]; ok {
		return suggestHidden(0.7, "Rated "+rating)
	}

	// 6. Mild rating with no other signal: unsure.
	if _, ok := mildRatings[rating]; ok {
		return suggestUnsure(0.5, "Rated "+rating+", no other signals")
	}

	// 7. Nothing to go on.
	return suggestUnsure(0.2, "No rating, no kid-studio match")
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

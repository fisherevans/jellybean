package server

import (
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// adminItemDTO is the wire shape returned by the admin item endpoints
// (handleAdminItems and handleAdminGetItem). The two handlers used to
// build this with hand-rolled `map[string]any` literals; centralizing
// in a typed struct prevents the field set from drifting between them.
//
// Field ordering matches the alphabetical key order Go's json encoder
// produces for a map, so the wire format is unchanged from the prior
// inline builders. Pointer-typed fields with omitempty (DateCreated,
// Suggestion) opt in per call site: handleAdminItems sets them, the
// single-item handler leaves them nil so they stay absent.
type adminItemDTO struct {
	AudioLanguage  string             `json:"AudioLanguage"`
	AudioLanguages []string           `json:"AudioLanguages"`
	DateCreated    *string            `json:"DateCreated,omitempty"`
	Genres         []string           `json:"Genres"`
	ID             string             `json:"Id"`
	ImageTags      jellyfin.ImageTags `json:"ImageTags"`
	Name           string             `json:"Name"`
	OfficialRating string             `json:"OfficialRating"`
	ProductionYear int                `json:"ProductionYear"`
	// State is the per-profile categorization (visible / hidden).
	// Encoded as JSON null when there is no row for this profile -
	// the kebab UI on each tile differentiates "unset" from "set".
	State      *string              `json:"State"`
	Studios    []jellyfin.Studio    `json:"Studios"`
	Suggestion *curation.Suggestion `json:"Suggestion,omitempty"`
	Tags       []adminItemTagDTO    `json:"Tags"`
	Type       string               `json:"Type"`
}

// adminItemTagDTO is the compact tag shape (id + name) the admin UI
// renders next to each item. Lowercase JSON keys are intentional and
// match the legacy inline builder.
type adminItemTagDTO struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// toAdminItemDTO builds the per-item wire payload. state is nil when
// the profile has no categorization row for the item. tags is the
// item's full tag set (may be empty). suggest is non-nil only when
// the caller asked for auto-categorization hints (handleAdminItems
// with ?suggest=true); the single-item handler always passes nil.
//
// DateCreated is populated unconditionally here; callers that don't
// want it on the wire (the single-item handler) should clear it.
func toAdminItemDTO(it jellyfin.Item, state *curation.State, tags []curation.Tag, suggest *curation.Suggestion) adminItemDTO {
	dto := adminItemDTO{
		AudioLanguage:  it.PrimaryAudioLanguage(),
		AudioLanguages: it.AudioLanguages(),
		Genres:         it.Genres,
		ID:             it.ID,
		ImageTags:      it.ImageTags,
		Name:           it.Name,
		OfficialRating: it.OfficialRating,
		ProductionYear: it.ProductionYear,
		Studios:        it.Studios,
		Suggestion:     suggest,
		Type:           it.Type,
	}
	dc := it.DateCreated
	dto.DateCreated = &dc
	if state != nil {
		s := string(*state)
		dto.State = &s
	}
	compact := make([]adminItemTagDTO, 0, len(tags))
	for _, tg := range tags {
		compact = append(compact, adminItemTagDTO{ID: tg.ID, Name: tg.Name})
	}
	dto.Tags = compact
	return dto
}

package server

import (
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/itemcache"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// adminItemListDTO is the slim per-item wire payload the admin items
// list endpoints (handleAdminItems, pageUnsetForProfile) serve. Built
// from the itemcache row so the list path never touches Jellyfin.
//
// Heavy fields (Genres, Studios, full MediaStreams) are intentionally
// absent: they're only useful on the detail view, and shipping them on
// every list row dominated the pre-cache 14s admin response. The audio
// badge keeps working via the cached PrimaryAudioLanguage + AudioLanguages
// + HasNonDefaultAudioLanguage tuple.
//
// JSON field names match the legacy adminItemDTO so the admin React
// client (api.ts -> Item type) keeps working unchanged.
type adminItemListDTO struct {
	AudioLanguage              string             `json:"AudioLanguage"`
	AudioLanguages             []string           `json:"AudioLanguages"`
	DateCreated                *string            `json:"DateCreated,omitempty"`
	HasNonDefaultAudioLanguage bool               `json:"HasNonDefaultAudioLanguage"`
	ID                         string             `json:"Id"`
	ImageTags                  jellyfin.ImageTags `json:"ImageTags"`
	Name                       string             `json:"Name"`
	OfficialRating             string             `json:"OfficialRating"`
	ProductionYear             int                `json:"ProductionYear"`
	// State is the per-profile categorization (visible / hidden).
	// Encoded as JSON null when there is no row for this profile -
	// the kebab UI on each tile differentiates "unset" from "set".
	State      *string              `json:"State"`
	Suggestion *curation.Suggestion `json:"Suggestion,omitempty"`
	Tags       []adminItemTagDTO    `json:"Tags"`
	Type       string               `json:"Type"`
}

// adminItemDTO is the full-fat wire shape returned by the single-item
// admin endpoint (handleAdminGetItem). Keeps Genres + Studios for the
// detail view; the live Jellyfin fetch on that path already carries
// IncludeHeavyFields=true.
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
	State          *string            `json:"State"`
	Studios        []jellyfin.Studio  `json:"Studios"`
	Suggestion     *curation.Suggestion `json:"Suggestion,omitempty"`
	Tags           []adminItemTagDTO  `json:"Tags"`
	Type           string             `json:"Type"`
}

// adminItemTagDTO is the compact tag shape (id + name) the admin UI
// renders next to each item. Lowercase JSON keys are intentional and
// match the legacy inline builder.
type adminItemTagDTO struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// adminItemListDTOFromCache builds the slim wire payload from a cache
// row. state is nil when the profile has no categorization row for
// the item. tags is the item's full tag set (may be empty). suggest is
// non-nil only when the caller asked for auto-categorization hints
// (handleAdminItems with ?suggest=true).
//
// DateCreated is populated unconditionally here; callers that don't
// want it on the wire should clear it.
func adminItemListDTOFromCache(row itemcache.Row, state *curation.State, tags []curation.Tag, suggest *curation.Suggestion) adminItemListDTO {
	dto := adminItemListDTO{
		AudioLanguage:              row.PrimaryAudioLanguage,
		AudioLanguages:             row.AudioLanguages,
		HasNonDefaultAudioLanguage: row.HasNonDefaultAudioLanguage,
		ID:                         row.ID,
		ImageTags:                  jellyfin.ImageTags{Primary: row.PrimaryImageTag},
		Name:                       row.Name,
		OfficialRating:             row.OfficialRating,
		ProductionYear:             row.ProductionYear,
		Suggestion:                 suggest,
		Type:                       row.Type,
	}
	if row.AudioLanguages == nil {
		dto.AudioLanguages = []string{}
	}
	dc := row.DateCreated
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

// adminItemListDTOFromJellyfin is the fallback when the cache misses
// (item not yet refreshed, or live search path that bypassed the
// cache). Same wire shape as adminItemListDTOFromCache - we just
// re-derive PrimaryAudioLanguage / AudioLanguages from the live
// MediaStreams instead of reading the cached columns. Genres +
// Studios + MediaStreams are dropped at the DTO layer either way.
func adminItemListDTOFromJellyfin(it jellyfin.Item, state *curation.State, tags []curation.Tag, suggest *curation.Suggestion) adminItemListDTO {
	dto := adminItemListDTO{
		AudioLanguage:              it.PrimaryAudioLanguage(),
		AudioLanguages:             it.AudioLanguages(),
		HasNonDefaultAudioLanguage: hasNonDefaultAudioLanguageItem(it),
		ID:                         it.ID,
		ImageTags:                  it.ImageTags,
		Name:                       it.Name,
		OfficialRating:             it.OfficialRating,
		ProductionYear:             it.ProductionYear,
		Suggestion:                 suggest,
		Type:                       it.Type,
	}
	if dto.AudioLanguages == nil {
		dto.AudioLanguages = []string{}
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

// toAdminItemDTO builds the full-fat per-item wire payload. Kept for
// the single-item detail endpoint which still goes through Jellyfin
// with IncludeHeavyFields=true.
//
// DateCreated is populated unconditionally; callers that don't want
// it on the wire (the single-item handler) should clear it.
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

// hasNonDefaultAudioLanguageItem mirrors itemcache's denormalization
// for live jellyfin.Item values - used on the cache-miss fallback so
// the wire shape stays consistent regardless of where the row came
// from.
func hasNonDefaultAudioLanguageItem(it jellyfin.Item) bool {
	hasAudio := false
	for _, s := range it.MediaStreams {
		if s.Type != "Audio" {
			continue
		}
		hasAudio = true
		if s.IsDefault && s.Language != "" {
			return false
		}
	}
	return hasAudio
}

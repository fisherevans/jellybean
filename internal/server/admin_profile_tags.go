package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
)

// Per-profile tag filter admin endpoints (M6 #38). The resolution
// rules these filters drive live in
// curation.EffectiveItemVisibility(Bulk).

type profileTagFilterResponse struct {
	TagID   int64  `json:"tagId"`
	TagName string `json:"tagName"`
	Mode    string `json:"mode"`
	SetAt   int64  `json:"setAt"`
}

// handleAdminListProfileTagFilters returns the filters set on a
// profile, enriched with the tag name so the UI doesn't need a
// separate roundtrip per filter row.
func (s *Server) handleAdminListProfileTagFilters(w http.ResponseWriter, r *http.Request) {
	id, err := parseIDParam(mux.Vars(r)["id"])
	if err != nil {
		http.Error(w, "bad profile id", http.StatusBadRequest)
		return
	}
	if _, err := s.curation.GetProfile(r.Context(), id); err != nil {
		if errors.Is(err, curation.ErrProfileNotFound) {
			http.Error(w, "profile not found", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Msg("get profile")
		http.Error(w, "failed to load profile", http.StatusInternalServerError)
		return
	}

	filters, err := s.curation.ListProfileTagFilters(r.Context(), id)
	if err != nil {
		s.logger.Error().Err(err).Msg("list profile tag filters")
		http.Error(w, "failed to load filters", http.StatusInternalServerError)
		return
	}

	// Resolve tag names by hand. A small inline map is cheaper than a
	// JOIN query at this scale (filter count = small int).
	tagNames := map[int64]string{}
	for _, f := range filters {
		if _, ok := tagNames[f.TagID]; ok {
			continue
		}
		tag, err := s.curation.GetTag(r.Context(), f.TagID)
		if err != nil {
			// CASCADE on tag delete should prevent orphans; if we
			// hit one anyway, surface it as "(unknown)" so the UI
			// has something to show.
			tagNames[f.TagID] = "(unknown)"
			continue
		}
		tagNames[f.TagID] = tag.Name
	}

	out := make([]profileTagFilterResponse, 0, len(filters))
	for _, f := range filters {
		out = append(out, profileTagFilterResponse{
			TagID:   f.TagID,
			TagName: tagNames[f.TagID],
			Mode:    string(f.Mode),
			SetAt:   f.SetAt.Unix(),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"profileId": id,
		"filters":   out,
	})
}

type profileTagFilterEntry struct {
	TagID int64  `json:"tagId"`
	Mode  string `json:"mode"`
}

// handleAdminPutProfileTagFilters replaces the profile's full filter
// set. Empty body clears all filters. Each tagId must exist; each
// mode must be always_visible | always_hidden.
//
// We do the replace in a "best effort sequential" loop rather than a
// transaction because the storage layer's SetProfileTagFilter +
// ClearProfileTagFilter are independently idempotent, and the failure
// modes here (unknown tag id, bad mode) all fail before any writes
// would happen because we validate up front.
func (s *Server) handleAdminPutProfileTagFilters(w http.ResponseWriter, r *http.Request) {
	id, err := parseIDParam(mux.Vars(r)["id"])
	if err != nil {
		http.Error(w, "bad profile id", http.StatusBadRequest)
		return
	}
	if _, err := s.curation.GetProfile(r.Context(), id); err != nil {
		if errors.Is(err, curation.ErrProfileNotFound) {
			http.Error(w, "profile not found", http.StatusNotFound)
			return
		}
		http.Error(w, "failed to load profile", http.StatusInternalServerError)
		return
	}

	var req []profileTagFilterEntry
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request: expected array of {tagId, mode}", http.StatusBadRequest)
		return
	}

	// Validate up front so partial writes can't leak through.
	desired := map[int64]curation.ProfileFilterMode{}
	for _, e := range req {
		if e.TagID <= 0 {
			http.Error(w, "tagId must be positive", http.StatusBadRequest)
			return
		}
		mode, err := curation.ParseProfileFilterMode(e.Mode)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if _, dup := desired[e.TagID]; dup {
			http.Error(w, fmt.Sprintf("tagId %d listed twice", e.TagID), http.StatusBadRequest)
			return
		}
		if _, err := s.curation.GetTag(r.Context(), e.TagID); err != nil {
			if errors.Is(err, curation.ErrTagNotFound) {
				http.Error(w, fmt.Sprintf("unknown tagId %d", e.TagID), http.StatusBadRequest)
				return
			}
			http.Error(w, "failed to validate tag", http.StatusInternalServerError)
			return
		}
		desired[e.TagID] = mode
	}

	// Snapshot existing so we know what to clear.
	existing, err := s.curation.ListProfileTagFilters(r.Context(), id)
	if err != nil {
		s.logger.Error().Err(err).Msg("snapshot existing filters")
		http.Error(w, "failed to load filters", http.StatusInternalServerError)
		return
	}
	existingByTag := map[int64]curation.ProfileFilterMode{}
	for _, f := range existing {
		existingByTag[f.TagID] = f.Mode
	}

	// Clear filters not in the desired set.
	for tagID := range existingByTag {
		if _, keep := desired[tagID]; keep {
			continue
		}
		if err := s.curation.ClearProfileTagFilter(r.Context(), id, tagID); err != nil {
			s.logger.Error().Err(err).Int64("tag", tagID).Msg("clear filter")
			http.Error(w, "failed to update filters", http.StatusInternalServerError)
			return
		}
	}
	// Set / update each desired filter.
	for tagID, mode := range desired {
		if existingByTag[tagID] == mode {
			continue
		}
		if err := s.curation.SetProfileTagFilter(r.Context(), id, tagID, mode); err != nil {
			s.logger.Error().Err(err).Int64("tag", tagID).Msg("set filter")
			http.Error(w, "failed to update filters", http.StatusInternalServerError)
			return
		}
	}

	// Re-read + return canonical state.
	s.handleAdminListProfileTagFilters(w, r)
}

// handleAdminDeleteProfileTagFilter clears a single (profile, tag) rule.
func (s *Server) handleAdminDeleteProfileTagFilter(w http.ResponseWriter, r *http.Request) {
	profileID, err := parseIDParam(mux.Vars(r)["id"])
	if err != nil {
		http.Error(w, "bad profile id", http.StatusBadRequest)
		return
	}
	tagID, err := parseIDParam(mux.Vars(r)["tagId"])
	if err != nil {
		http.Error(w, "bad tag id", http.StatusBadRequest)
		return
	}
	if err := s.curation.ClearProfileTagFilter(r.Context(), profileID, tagID); err != nil {
		s.logger.Error().Err(err).Msg("clear profile tag filter")
		http.Error(w, "failed to clear filter", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

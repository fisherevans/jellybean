package server

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
)

// Item-tag mapping endpoints (M6 #36). The tag-filtered listing
// branch is in handleAdminItems (admin.go) since it shares the
// existing pagination + decoration pipeline.

// handleAdminGetItemTags returns the tag set currently applied to one
// item. Light wrapper over the storage call - kept separate from the
// items listing so a tile UI can refresh just one item's tags after
// a kebab toggle without re-paging.
func (s *Server) handleAdminGetItemTags(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	tags, err := s.curation.GetTagsForItem(r.Context(), id)
	if err != nil {
		s.logger.Error().Err(err).Str("item", id).Msg("get tags for item")
		http.Error(w, "failed to load tags", http.StatusInternalServerError)
		return
	}
	out := make([]tagResponse, 0, len(tags))
	for _, t := range tags {
		out = append(out, toBareTagResponse(t))
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": out})
}

type setItemTagsRequest struct {
	TagIDs []int64 `json:"tagIds"`
}

// handleAdminSetItemTags replaces the entire tag set for an item.
// Empty TagIDs clears all tags.
//
// Validation:
//   - Every tag id in the request must exist; on miss, returns 400 with
//     the offending ids in the body so the UI can highlight them.
//   - The item must be visible for at least one profile, unless
//     ?force=true is set. This guards the common case where an admin
//     accidentally tags a hidden-only item; the cleanup flow uses
//     force=true.
func (s *Server) handleAdminSetItemTags(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}

	req, err := decodeJSON[setItemTagsRequest](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Validate each tag id exists. We do this in a tight loop because
	// the tag count is small; if we ever scale this we'd batch via a
	// SELECT IN (...).
	missing := []int64{}
	for _, tid := range req.TagIDs {
		if tid <= 0 {
			missing = append(missing, tid)
			continue
		}
		if _, err := s.curation.GetTag(r.Context(), tid); err != nil {
			if errors.Is(err, curation.ErrTagNotFound) {
				missing = append(missing, tid)
				continue
			}
			s.logger.Error().Err(err).Int64("tag_id", tid).Msg("validate tag id")
			http.Error(w, "failed to validate tags", http.StatusInternalServerError)
			return
		}
	}
	if len(missing) > 0 {
		http.Error(w, fmt.Sprintf("unknown tag ids: %v", missing), http.StatusBadRequest)
		return
	}

	// Visible-only guard. ?force=true skips it. Skipped automatically
	// when the caller is clearing tags (TagIDs is empty) since clearing
	// a tag from a hidden item is the legitimate cleanup path.
	if r.URL.Query().Get("force") != "true" && len(req.TagIDs) > 0 {
		visible, err := s.curation.IsItemVisibleForAnyProfile(r.Context(), id)
		if err != nil {
			s.logger.Error().Err(err).Str("item", id).Msg("visibility precheck")
			http.Error(w, "failed to validate item visibility", http.StatusInternalServerError)
			return
		}
		if !visible {
			http.Error(w,
				"item is not visible for any profile; pass ?force=true to override",
				http.StatusConflict)
			return
		}
	}

	if err := s.curation.SetTagsForItem(r.Context(), id, req.TagIDs, sessionUserID(r)); err != nil {
		s.logger.Error().Err(err).Str("item", id).Msg("set tags for item")
		http.Error(w, "failed to set tags", http.StatusInternalServerError)
		return
	}

	tags, err := s.curation.GetTagsForItem(r.Context(), id)
	if err != nil {
		s.logger.Error().Err(err).Str("item", id).Msg("re-read tags")
		http.Error(w, "failed to load tags", http.StatusInternalServerError)
		return
	}
	out := make([]tagResponse, 0, len(tags))
	for _, t := range tags {
		out = append(out, toBareTagResponse(t))
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": out})
}

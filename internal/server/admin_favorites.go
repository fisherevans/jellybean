package server

import (
	"net/http"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// Per-kid favorites admin endpoints (M6 #37). Storage lives in
// internal/curation/tags.go (kid_favorites table); this file is the
// HTTP wiring + the Jellyfin item-decoration the UI needs to render
// thumbnails alongside the favorite list.

// handleAdminListKidFavorites returns the kid's favorites, decorated
// with item metadata so the admin UI can render thumbnails + names.
//
// Items the kid favorited but that are no longer visible for the
// kid's profile are still returned. The UI surfaces them with a small
// "now hidden" indicator and lets the admin decide whether to drop
// the favorite (per the design - we do NOT auto-prune).
func (s *Server) handleAdminListKidFavorites(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad kid id", http.StatusBadRequest)
		return
	}
	kid, err := s.curation.GetKid(r.Context(), id)
	if err != nil {
		if writeDomainError(w, err) {
			return
		}
		s.logger.Error().Err(err).Msg("get kid")
		http.Error(w, "failed to load kid", http.StatusInternalServerError)
		return
	}
	favs, err := s.curation.ListKidFavorites(r.Context(), id)
	if err != nil {
		s.logger.Error().Err(err).Msg("list kid favorites")
		http.Error(w, "failed to load favorites", http.StatusInternalServerError)
		return
	}
	itemIDs := make([]string, len(favs))
	for i, f := range favs {
		itemIDs[i] = f.JellyfinItemID
	}

	// Pull item metadata + per-profile state in parallel-ish (sequential
	// here; calls are small + Jellyfin is local). The state map drives
	// the "still visible to this kid's profile?" indicator.
	itemsByID := map[string]jellyfin.Item{}
	if len(itemIDs) > 0 {
		res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{IDs: itemIDs})
		if err != nil {
			s.logger.Error().Err(err).Msg("favorites item batch")
			http.Error(w, "failed to load favorites items", http.StatusBadGateway)
			return
		}
		for _, it := range res.Items {
			itemsByID[it.ID] = it
		}
	}
	visibility, err := s.curation.EffectiveItemVisibilityBulk(r.Context(), kid.ProfileID, itemIDs)
	if err != nil {
		s.logger.Error().Err(err).Msg("favorites visibility")
		http.Error(w, "failed to load visibility", http.StatusInternalServerError)
		return
	}

	out := make([]map[string]any, 0, len(favs))
	for _, f := range favs {
		row := map[string]any{
			"itemId":    f.JellyfinItemID,
			"createdAt": f.CreatedAt.Unix(),
			"visible":   visibility[f.JellyfinItemID] == curation.StateVisible,
		}
		if it, ok := itemsByID[f.JellyfinItemID]; ok {
			row["name"] = it.Name
			row["type"] = it.Type
			row["productionYear"] = it.ProductionYear
			row["imageTags"] = it.ImageTags
		} else {
			// Jellyfin doesn't know this item anymore (deleted /
			// renamed). Keep the row but flag it so the UI can
			// offer a cleanup action.
			row["missing"] = true
		}
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"kidId":     kid.ID,
		"profileId": kid.ProfileID,
		"favorites": out,
	})
}

// handleAdminAddKidFavorite is idempotent (the underlying storage
// uses ON CONFLICT DO NOTHING). Returns 204 either way.
func (s *Server) handleAdminAddKidFavorite(w http.ResponseWriter, r *http.Request) {
	kidID, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad kid id", http.StatusBadRequest)
		return
	}
	itemID := mux.Vars(r)["itemId"]
	if itemID == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	// Confirm the kid exists so a typo'd id doesn't silently no-op.
	if _, err := s.curation.GetKid(r.Context(), kidID); err != nil {
		if writeDomainError(w, err) {
			return
		}
		s.logger.Error().Err(err).Msg("get kid")
		http.Error(w, "failed to validate kid", http.StatusInternalServerError)
		return
	}
	if err := s.curation.AddKidFavorite(r.Context(), kidID, itemID); err != nil {
		s.logger.Error().Err(err).Msg("add kid favorite")
		http.Error(w, "failed to add favorite", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleAdminRemoveKidFavorite drops the (kid, item) row. Returns 204
// whether or not the row existed - removing a non-favorite is a no-op
// for the UI.
func (s *Server) handleAdminRemoveKidFavorite(w http.ResponseWriter, r *http.Request) {
	kidID, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad kid id", http.StatusBadRequest)
		return
	}
	itemID := mux.Vars(r)["itemId"]
	if itemID == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	if err := s.curation.RemoveKidFavorite(r.Context(), kidID, itemID); err != nil {
		s.logger.Error().Err(err).Msg("remove kid favorite")
		http.Error(w, "failed to remove favorite", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

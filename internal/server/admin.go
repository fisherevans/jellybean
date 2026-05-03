package server

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// handleAdminItems lists items from Jellyfin, scoped by the ?type= query
// param. Used by the admin dashboard's M1 streaming proof; later milestones
// add filters and pagination.
func (s *Server) handleAdminItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	itemType := q.Get("type")
	if itemType == "" {
		itemType = "Movie"
	}
	limit := 20
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}

	res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{
		IncludeItemTypes: []string{itemType},
		Recursive:        true,
		Limit:            limit,
		SortBy:           "SortName",
		SortOrder:        "Ascending",
	})
	if err != nil {
		s.logger.Error().Err(err).Msg("list items")
		http.Error(w, "failed to list items", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleAdminStream redirects the browser to Jellyfin's direct-play URL for
// the requested item, signed with the Jellybean service-account API key.
// The redirect target is what the <video> element follows.
func (s *Server) handleAdminStream(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	if _, err := s.jellyfin.GetItem(r.Context(), id); err != nil {
		if errors.Is(err, jellyfin.ErrNotFound) {
			http.Error(w, "item not found", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Str("id", id).Msg("verify item before stream")
		http.Error(w, "failed to resolve item", http.StatusBadGateway)
		return
	}
	url := s.jellyfin.StreamURL(id, "") // "" => fall back to service-account key
	http.Redirect(w, r, url, http.StatusFound)
}

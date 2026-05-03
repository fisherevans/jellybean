package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// handleAdminItems lists items from Jellyfin, optionally filtered by our
// local categorization state and a server-side search term. Each returned
// item is enriched with its current category so the UI can render and act
// on it without a second round trip.
//
// Query params:
//   type      - Jellyfin item type (default Movie)
//   limit     - 1..200, default 50
//   search    - substring on name (passed through to Jellyfin's searchTerm)
//   category  - kid | adult | uncategorized; if set, only items in that
//               category are returned
func (s *Server) handleAdminItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	itemType := q.Get("type")
	if itemType == "" {
		itemType = "Movie"
	}
	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	search := q.Get("search")

	var wantCat curation.Category
	if c := q.Get("category"); c != "" {
		parsed, err := curation.ParseCategory(c)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		wantCat = parsed
	}

	// Fetch a generous batch from Jellyfin so we have something to filter
	// even after dropping items in the wrong category. Cap at 1000 so we
	// never blow up on the search term being empty.
	fetchLimit := limit
	if wantCat != "" {
		fetchLimit = 1000
	}

	res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{
		IncludeItemTypes: []string{itemType},
		Recursive:        true,
		Limit:            fetchLimit,
		SortBy:           "SortName",
		SortOrder:        "Ascending",
		SearchTerm:       search,
	})
	if err != nil {
		s.logger.Error().Err(err).Msg("list items")
		http.Error(w, "failed to list items", http.StatusBadGateway)
		return
	}

	// Pull categories for the returned items.
	ids := make([]string, len(res.Items))
	for i, it := range res.Items {
		ids[i] = it.ID
	}
	cats, err := s.curation.GetCategoriesForItems(r.Context(), ids)
	if err != nil {
		s.logger.Error().Err(err).Msg("fetch categories")
		http.Error(w, "failed to load categories", http.StatusInternalServerError)
		return
	}

	enriched := make([]map[string]any, 0, len(res.Items))
	for _, it := range res.Items {
		cat := cats[it.ID]
		if cat == "" {
			cat = curation.CategoryUncategorized
		}
		if wantCat != "" && cat != wantCat {
			continue
		}
		enriched = append(enriched, map[string]any{
			"Id":             it.ID,
			"Name":           it.Name,
			"Type":           it.Type,
			"OfficialRating": it.OfficialRating,
			"Genres":         it.Genres,
			"Studios":        it.Studios,
			"ProductionYear": it.ProductionYear,
			"ImageTags":      it.ImageTags,
			"Category":       string(cat),
		})
		if len(enriched) >= limit {
			break
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"Items":            enriched,
		"TotalRecordCount": res.TotalRecordCount,
		"ReturnedCount":    len(enriched),
	})
}

type setCategoryRequest struct {
	Category string `json:"category"`
}

func (s *Server) handleAdminSetCategory(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	var req setCategoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	cat, err := curation.ParseCategory(req.Category)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	sess := auth.SessionFromContext(r.Context())
	setBy := ""
	if sess != nil {
		setBy = sess.UserID
	}
	if _, err := s.curation.SetCategory(r.Context(), id, cat, setBy); err != nil {
		s.logger.Error().Err(err).Str("id", id).Msg("set category")
		http.Error(w, "failed to set category", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type bulkCategoryRequest struct {
	ItemIDs  []string `json:"itemIds"`
	Category string   `json:"category"`
}

func (s *Server) handleAdminBulkCategory(w http.ResponseWriter, r *http.Request) {
	var req bulkCategoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	cat, err := curation.ParseCategory(req.Category)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if len(req.ItemIDs) == 0 {
		http.Error(w, "itemIds required", http.StatusBadRequest)
		return
	}
	if len(req.ItemIDs) > 1000 {
		http.Error(w, "too many items in one bulk (max 1000)", http.StatusBadRequest)
		return
	}
	sess := auth.SessionFromContext(r.Context())
	setBy := ""
	if sess != nil {
		setBy = sess.UserID
	}
	updated, err := s.curation.SetCategoryBulk(r.Context(), req.ItemIDs, cat, setBy)
	if err != nil {
		s.logger.Error().Err(err).Msg("bulk set category")
		http.Error(w, "failed to apply bulk category", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"updated": updated})
}

func (s *Server) handleAdminRecentActivity(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	hist, err := s.curation.RecentHistory(r.Context(), limit)
	if err != nil {
		s.logger.Error().Err(err).Msg("recent history")
		http.Error(w, "failed to load history", http.StatusInternalServerError)
		return
	}

	// Enrich with item names from Jellyfin so the UI doesn't have to round-
	// trip per row. One call per unique item id; small N (<= limit), so the
	// cost is bounded.
	type historyResponse struct {
		ID           int64  `json:"id"`
		ItemID       string `json:"itemId"`
		ItemName     string `json:"itemName"`
		FromCategory string `json:"fromCategory,omitempty"`
		ToCategory   string `json:"toCategory"`
		ChangedBy    string `json:"changedBy,omitempty"`
		ChangedAt    int64  `json:"changedAt"`
	}
	out := make([]historyResponse, 0, len(hist))
	nameCache := map[string]string{}
	for _, h := range hist {
		name, ok := nameCache[h.ItemID]
		if !ok {
			item, err := s.jellyfin.GetItem(r.Context(), h.ItemID)
			if err == nil {
				name = item.Name
			} else if errors.Is(err, jellyfin.ErrNotFound) {
				name = "(deleted)"
			} else {
				s.logger.Warn().Err(err).Str("id", h.ItemID).Msg("history item lookup")
				name = "(unknown)"
			}
			nameCache[h.ItemID] = name
		}
		out = append(out, historyResponse{
			ID:           h.ID,
			ItemID:       h.ItemID,
			ItemName:     name,
			FromCategory: string(h.FromCategory),
			ToCategory:   string(h.ToCategory),
			ChangedBy:    h.ChangedBy,
			ChangedAt:    h.ChangedAt.Unix(),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": out})
}

// handleAdminStream returns the Jellyfin HLS manifest URL for the requested
// item as JSON. We don't 302-redirect: hls.js needs to know the URL is HLS
// (the original /api/admin/... path doesn't end in .m3u8) so it engages
// instead of letting the browser try to natively decode the manifest.
func (s *Server) handleAdminStream(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	item, err := s.jellyfin.GetItem(r.Context(), id)
	if err != nil {
		if errors.Is(err, jellyfin.ErrNotFound) {
			http.Error(w, "item not found", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Str("id", id).Msg("verify item before stream")
		http.Error(w, "failed to resolve item", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"streamUrl": s.jellyfin.StreamURL(id, ""),
		"itemId":    id,
		"itemName":  item.Name,
	})
}

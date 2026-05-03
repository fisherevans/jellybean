package server

import (
	"context"
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
//   type        - Jellyfin item type (default Movie)
//   limit       - 1..200, default 50
//   startIndex  - pagination offset, default 0
//   search      - substring on name (passed through to Jellyfin's searchTerm),
//                 capped at 200 chars
//   category    - kid | adult | uncategorized; if set, only items in that
//                 category are returned
//   suggest     - "true" to enrich each item with an auto-categorization
//                 suggestion
//
// Filter semantics differ by category to avoid the truncation bug where a
// naive "fetch first 1000 from Jellyfin and filter" loses everything past
// the cutoff. For kid/adult we read IDs from our DB (which is already
// scoped) and ask Jellyfin for those specific items via Ids=. For
// uncategorized we page through Jellyfin and skip anything our DB has a
// row for.
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
	startIndex := 0
	if v := q.Get("startIndex"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			startIndex = n
		}
	}
	search := q.Get("search")
	if len(search) > 200 {
		search = search[:200]
	}
	withSuggest := q.Get("suggest") == "true"

	var wantCat curation.Category
	if c := q.Get("category"); c != "" {
		parsed, err := curation.ParseCategory(c)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		wantCat = parsed
	}

	var (
		items     []jellyfin.Item
		total     int
		hasMore   bool
		nextStart = startIndex
	)

	switch wantCat {
	case curation.CategoryKid, curation.CategoryAdult:
		ids, err := s.curation.ListItemIDsInCategory(r.Context(), wantCat, limit+1, startIndex)
		if err != nil {
			s.logger.Error().Err(err).Msg("list category ids")
			http.Error(w, "failed to load items", http.StatusInternalServerError)
			return
		}
		hasMore = len(ids) > limit
		if hasMore {
			ids = ids[:limit]
		}
		if len(ids) > 0 {
			res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{
				IDs: ids,
			})
			if err != nil {
				s.logger.Error().Err(err).Msg("get items by ids")
				http.Error(w, "failed to load items", http.StatusBadGateway)
				return
			}
			items = res.Items
			total = res.TotalRecordCount
		}

	case curation.CategoryUncategorized:
		excluded, err := s.curation.AllNonUncategorizedIDs(r.Context())
		if err != nil {
			s.logger.Error().Err(err).Msg("load excluded ids")
			http.Error(w, "failed to load items", http.StatusInternalServerError)
			return
		}
		items, total, nextStart, err = s.pageUncategorized(r.Context(), itemType, search, limit, startIndex, excluded)
		if err != nil {
			s.logger.Error().Err(err).Msg("page items")
			http.Error(w, "failed to load items", http.StatusBadGateway)
			return
		}
		// Tell the client the Jellyfin cursor to resume from. They pass it
		// back as startIndex on the next request; user-space pagination
		// would be ambiguous after items get re-categorized between pages.
		hasMore = nextStart < total

	default:
		res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{
			IncludeItemTypes: []string{itemType},
			Recursive:        true,
			Limit:            limit,
			StartIndex:       startIndex,
			SortBy:           "SortName",
			SortOrder:        "Ascending",
			SearchTerm:       search,
		})
		if err != nil {
			s.logger.Error().Err(err).Msg("list items")
			http.Error(w, "failed to list items", http.StatusBadGateway)
			return
		}
		items = res.Items
		total = res.TotalRecordCount
		nextStart = startIndex + len(items)
		hasMore = nextStart < total
	}

	// Pull categories for whatever set of items we ended up with.
	idList := make([]string, len(items))
	for i, it := range items {
		idList[i] = it.ID
	}
	cats, err := s.curation.GetCategoriesForItems(r.Context(), idList)
	if err != nil {
		s.logger.Error().Err(err).Msg("fetch categories")
		http.Error(w, "failed to load categories", http.StatusInternalServerError)
		return
	}

	enriched := make([]map[string]any, 0, len(items))
	for _, it := range items {
		cat := cats[it.ID]
		if cat == "" {
			cat = curation.CategoryUncategorized
		}
		row := map[string]any{
			"Id":             it.ID,
			"Name":           it.Name,
			"Type":           it.Type,
			"OfficialRating": it.OfficialRating,
			"Genres":         it.Genres,
			"Studios":        it.Studios,
			"ProductionYear": it.ProductionYear,
			"ImageTags":      it.ImageTags,
			"Category":       string(cat),
		}
		if withSuggest {
			row["Suggestion"] = curation.Suggest(it)
		}
		enriched = append(enriched, row)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"Items":            enriched,
		"TotalRecordCount": total,
		"ReturnedCount":    len(enriched),
		"StartIndex":       startIndex,
		"NextStartIndex":   nextStart,
		"HasMore":          hasMore,
	})
}

// pageUncategorized walks Jellyfin's catalog from `startIndex` forward,
// skipping any item already in the categorizations table, until it has
// `limit` matching items or hits the end of the catalog. Returns the
// matched items, Jellyfin's TotalRecordCount, and the Jellyfin offset to
// resume from on the next request.
func (s *Server) pageUncategorized(
	ctx context.Context,
	itemType, search string,
	limit, startIndex int,
	excluded map[string]struct{},
) ([]jellyfin.Item, int, int, error) {
	const pageSize = 200
	const maxPages = 50

	var (
		items []jellyfin.Item
		total int
		idx   = startIndex
	)
	for page := 0; page < maxPages; page++ {
		res, err := s.jellyfin.GetItems(ctx, jellyfin.ItemsFilter{
			IncludeItemTypes: []string{itemType},
			Recursive:        true,
			Limit:            pageSize,
			StartIndex:       idx,
			SortBy:           "SortName",
			SortOrder:        "Ascending",
			SearchTerm:       search,
		})
		if err != nil {
			return nil, 0, idx, err
		}
		total = res.TotalRecordCount
		if len(res.Items) == 0 {
			break
		}
		for j, it := range res.Items {
			if _, isCategorized := excluded[it.ID]; isCategorized {
				continue
			}
			items = append(items, it)
			if len(items) >= limit {
				// Resume cursor sits one past the last consumed Jellyfin item.
				return items, total, idx + j + 1, nil
			}
		}
		idx += len(res.Items)
		if len(res.Items) < pageSize {
			break
		}
	}
	return items, total, idx, nil
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

	// Single batch fetch of names from Jellyfin via Ids=...; one round trip
	// regardless of history length.
	uniqueIDs := make([]string, 0, len(hist))
	seen := map[string]struct{}{}
	for _, h := range hist {
		if _, ok := seen[h.ItemID]; ok {
			continue
		}
		seen[h.ItemID] = struct{}{}
		uniqueIDs = append(uniqueIDs, h.ItemID)
	}
	names := map[string]string{}
	if len(uniqueIDs) > 0 {
		res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{IDs: uniqueIDs})
		if err != nil {
			s.logger.Warn().Err(err).Msg("history names batch")
			// Non-fatal: we'll fill in (unknown) below for missing names.
		} else {
			for _, it := range res.Items {
				names[it.ID] = it.Name
			}
		}
	}

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
	for _, h := range hist {
		name, ok := names[h.ItemID]
		if !ok {
			name = "(unknown)"
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

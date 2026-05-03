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

// sessionUserID extracts the Jellyfin user id of the authenticated admin
// from the request context, or empty if there is no session (which only
// happens on routes deliberately not behind auth).
func sessionUserID(r *http.Request) string {
	sess := auth.SessionFromContext(r.Context())
	if sess == nil {
		return ""
	}
	return sess.UserID
}

// handleAdminItems lists items from Jellyfin, optionally filtered by our
// local categorization state and a server-side search term. Each returned
// item is enriched with its current minAge + bucket so the UI can render
// and act on it without a second round trip.
//
// Query params:
//   type        - Jellyfin item type (default Movie)
//   limit       - 1..200, default 50
//   startIndex  - pagination offset, default 0
//   search      - substring on name (passed through to Jellyfin's searchTerm),
//                 capped at 200 chars
//   category    - kid | adult | uncategorized; coarse bucket filter mapped
//                 from min_age (kid = age < 13, adult = age >= 13)
//   suggest     - "true" to enrich each item with an auto-categorization
//                 suggestion
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

	var wantBucket curation.AgeBucket
	if c := q.Get("category"); c != "" {
		parsed, err := curation.ParseBucket(c)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		wantBucket = parsed
	}

	var (
		items     []jellyfin.Item
		total     int
		hasMore   bool
		nextStart = startIndex
	)

	switch wantBucket {
	case curation.BucketKid, curation.BucketAdult:
		ids, err := s.curation.ListItemIDsInBucket(r.Context(), wantBucket, limit+1, startIndex)
		if err != nil {
			s.logger.Error().Err(err).Msg("list bucket ids")
			http.Error(w, "failed to load items", http.StatusInternalServerError)
			return
		}
		hasMore = len(ids) > limit
		if hasMore {
			ids = ids[:limit]
		}
		if len(ids) > 0 {
			res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{IDs: ids})
			if err != nil {
				s.logger.Error().Err(err).Msg("get items by ids")
				http.Error(w, "failed to load items", http.StatusBadGateway)
				return
			}
			items = res.Items
			total = res.TotalRecordCount
		}

	case curation.BucketUncategorized:
		excluded, err := s.curation.AllCategorizedIDs(r.Context())
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

	idList := make([]string, len(items))
	for i, it := range items {
		idList[i] = it.ID
	}
	ages, err := s.curation.GetAgesForItems(r.Context(), idList)
	if err != nil {
		s.logger.Error().Err(err).Msg("fetch ages")
		http.Error(w, "failed to load categories", http.StatusInternalServerError)
		return
	}

	enriched := make([]map[string]any, 0, len(items))
	for _, it := range items {
		row := map[string]any{
			"Id":             it.ID,
			"Name":           it.Name,
			"Type":           it.Type,
			"OfficialRating": it.OfficialRating,
			"Genres":         it.Genres,
			"Studios":        it.Studios,
			"ProductionYear": it.ProductionYear,
			"ImageTags":      it.ImageTags,
		}
		if age, ok := ages[it.ID]; ok {
			row["MinAge"] = age
			row["Bucket"] = string(curation.AgeToBucket(&age))
		} else {
			row["MinAge"] = nil
			row["Bucket"] = string(curation.BucketUncategorized)
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
// `limit` matching items or hits the end of the catalog.
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

// setAgeRequest carries a nullable minAge so the client can tag an item
// uncategorized by sending null. Validity is enforced at the handler.
type setAgeRequest struct {
	MinAge *int `json:"minAge"`
}

// validAgeTier returns true for ages we accept as a stored tier, plus nil
// (which means uncategorized). Constrains user input to the curated set so
// stray values like 137 don't slip into the table.
func validAgeTier(age *int) bool {
	if age == nil {
		return true
	}
	switch *age {
	case curation.AgeToddler, curation.AgePreschool, curation.AgeKid, curation.AgeTeen, curation.AgeAdult:
		return true
	}
	return false
}

func (s *Server) handleAdminSetAge(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	var req setAgeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !validAgeTier(req.MinAge) {
		http.Error(w, "minAge must be null or one of 2,5,7,13,18", http.StatusBadRequest)
		return
	}
	if _, err := s.curation.SetAge(r.Context(), id, req.MinAge, sessionUserID(r)); err != nil {
		s.logger.Error().Err(err).Str("id", id).Msg("set age")
		http.Error(w, "failed to set age", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type bulkAgeRequest struct {
	ItemIDs []string `json:"itemIds"`
	MinAge  *int     `json:"minAge"`
}

func (s *Server) handleAdminBulkAge(w http.ResponseWriter, r *http.Request) {
	var req bulkAgeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !validAgeTier(req.MinAge) {
		http.Error(w, "minAge must be null or one of 2,5,7,13,18", http.StatusBadRequest)
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
	updated, err := s.curation.SetAgeBulk(r.Context(), req.ItemIDs, req.MinAge, sessionUserID(r))
	if err != nil {
		s.logger.Error().Err(err).Msg("bulk set age")
		http.Error(w, "failed to apply bulk age", http.StatusInternalServerError)
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
		} else {
			for _, it := range res.Items {
				names[it.ID] = it.Name
			}
		}
	}

	type historyResponse struct {
		ID         int64  `json:"id"`
		ItemID     string `json:"itemId"`
		ItemName   string `json:"itemName"`
		FromMinAge *int   `json:"fromMinAge"`
		ToMinAge   *int   `json:"toMinAge"`
		ChangedBy  string `json:"changedBy,omitempty"`
		ChangedAt  int64  `json:"changedAt"`
	}
	out := make([]historyResponse, 0, len(hist))
	for _, h := range hist {
		name, ok := names[h.ItemID]
		if !ok {
			name = "(unknown)"
		}
		out = append(out, historyResponse{
			ID:         h.ID,
			ItemID:     h.ItemID,
			ItemName:   name,
			FromMinAge: h.FromAge,
			ToMinAge:   h.ToAge,
			ChangedBy:  h.ChangedBy,
			ChangedAt:  h.ChangedAt.Unix(),
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

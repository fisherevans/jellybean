package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/itemcache"
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

// requireProfileID parses the profileId query param. It is required for
// any handler that operates on per-profile state (set, bulk, list filtered
// by state). Returns 400 with a helpful message when missing or invalid.
func requireProfileID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	v := r.URL.Query().Get("profileId")
	if v == "" {
		http.Error(w, "profileId query param required", http.StatusBadRequest)
		return 0, false
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		http.Error(w, "profileId must be a positive integer", http.StatusBadRequest)
		return 0, false
	}
	return n, true
}

// handleAdminItems lists items from Jellyfin, optionally filtered by the
// active profile's visibility state and a server-side search term. Each
// returned item is enriched with its current state for the active profile
// so the UI can render and act on it without a second round trip.
//
// Query params:
//
//	profileId  - REQUIRED. Which profile's state to surface and filter by.
//	type       - Jellyfin item type (default Movie)
//	limit      - 1..200, default 50
//	startIndex - pagination offset, default 0
//	search     - substring on name (passed through to Jellyfin's
//	             searchTerm), capped at 200 chars
//	state      - visible | hidden | unset; if set, only items in that
//	             state for this profile are returned
//	suggest    - "true" to enrich each item with an auto-categorization
//	             suggestion
func (s *Server) handleAdminItems(w http.ResponseWriter, r *http.Request) {
	profileID, ok := requireProfileID(w, r)
	if !ok {
		return
	}

	q := r.URL.Query()
	// type accepts a comma-separated list. Defaults to Movie + Series so a
	// caller without an explicit filter sees the whole curatable library.
	// Allowed values: Movie, Series. Anything else returns 400.
	rawType := q.Get("type")
	if rawType == "" {
		rawType = "Movie,Series"
	}
	itemTypes := []string{}
	for _, t := range strings.Split(rawType, ",") {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		switch t {
		case "Movie", "Series":
			itemTypes = append(itemTypes, t)
		default:
			http.Error(w, "type must be Movie, Series, or both", http.StatusBadRequest)
			return
		}
	}
	if len(itemTypes) == 0 {
		http.Error(w, "type cannot be empty", http.StatusBadRequest)
		return
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

	type stateFilter int
	const (
		filterAll stateFilter = iota
		filterVisible
		filterHidden
		filterUnset
	)
	wantState := filterAll
	switch q.Get("state") {
	case "":
		// no filter
	case string(curation.StateVisible):
		wantState = filterVisible
	case string(curation.StateHidden):
		wantState = filterHidden
	case "unset":
		wantState = filterUnset
	default:
		http.Error(w, "state must be visible, hidden, or unset", http.StatusBadRequest)
		return
	}
	// Search spans all visibility states. The visible/hidden state filter
	// only makes sense once the user is browsing a curated subset; when
	// they're hunting for an item by name, dropping uncategorized rows is
	// confusing (the user reasonably expects to find items they haven't
	// touched yet). Fall through to the cache-backed default branch which
	// does case-insensitive substring search and stamps State per row.
	if search != "" {
		wantState = filterAll
	}

	// Optional ?tagId=N filter. When set, the result set is the items
	// carrying that tag (regardless of categorization state) - admin
	// flows want to see hidden-but-tagged items so they can untag or
	// recategorize. tagId composes with type: a tag is global, but the
	// caller can still narrow by Movie / Series.
	var filterTagID int64
	if v := q.Get("tagId"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			http.Error(w, "tagId must be a positive integer", http.StatusBadRequest)
			return
		}
		filterTagID = n
	}

	// rows is the source of truth for the list payload. Both the
	// cache-driven paths (state filter, unset, default listing) and
	// the Jellyfin-driven paths (tag filter, search inside state) end
	// up populating this slice of cache rows; cache misses for
	// Jellyfin-only ids are filled via adminItemListDTOFromJellyfin
	// below so the wire shape stays consistent.
	var (
		rows      []itemcache.Row
		fallback  []jellyfin.Item // ids not in cache - decorated live
		total     int
		hasMore   bool
		nextStart = startIndex
	)

	allowedTypes := map[string]struct{}{}
	for _, t := range itemTypes {
		allowedTypes[t] = struct{}{}
	}

	if filterTagID > 0 {
		ids, err := s.curation.ListItemIDsByTag(r.Context(), filterTagID, limit+1, startIndex)
		if err != nil {
			s.logger.Error().Err(err).Msg("list ids by tag")
			http.Error(w, "failed to load items", http.StatusInternalServerError)
			return
		}
		hasMore = len(ids) > limit
		if hasMore {
			ids = ids[:limit]
		}
		if len(ids) > 0 {
			cached, missing, err := s.loadRowsByIDs(r.Context(), ids)
			if err != nil {
				s.logger.Error().Err(err).Msg("get items by ids (tag filter)")
				http.Error(w, "failed to load items", http.StatusBadGateway)
				return
			}
			rows = filterRowsByType(cached, allowedTypes)
			if len(missing) > 0 {
				live, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{IDs: missing, IncludeHeavyFields: true})
				if err != nil {
					s.logger.Error().Err(err).Msg("tag filter live miss")
					http.Error(w, "failed to load items", http.StatusBadGateway)
					return
				}
				for _, it := range live.Items {
					if _, ok := allowedTypes[it.Type]; ok {
						fallback = append(fallback, it)
					}
				}
			}
			total = len(rows) + len(fallback)
		}
		nextStart = startIndex + len(rows) + len(fallback)
		goto enrich
	}

	switch wantState {
	case filterVisible, filterHidden:
		// Note: search != "" was rewritten to filterAll above, so this
		// branch only runs for state-only filtering (no search term).
		st := curation.StateVisible
		if wantState == filterHidden {
			st = curation.StateHidden
		}
		countTotal, err := s.curation.CountItemIDsInState(r.Context(), profileID, st)
		if err != nil {
			s.logger.Error().Err(err).Msg("count state ids")
			http.Error(w, "failed to load items", http.StatusInternalServerError)
			return
		}
		ids, err := s.curation.ListItemIDsInState(r.Context(), profileID, st, limit+1, startIndex)
		if err != nil {
			s.logger.Error().Err(err).Msg("list state ids")
			http.Error(w, "failed to load items", http.StatusInternalServerError)
			return
		}
		hasMore = len(ids) > limit
		if hasMore {
			ids = ids[:limit]
		}
		if len(ids) > 0 {
			cached, missing, err := s.loadRowsByIDs(r.Context(), ids)
			if err != nil {
				s.logger.Error().Err(err).Msg("get items by ids")
				http.Error(w, "failed to load items", http.StatusBadGateway)
				return
			}
			rows = cached
			if len(missing) > 0 {
				live, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{IDs: missing, IncludeHeavyFields: true})
				if err != nil {
					s.logger.Error().Err(err).Msg("state-filter live miss")
					http.Error(w, "failed to load items", http.StatusBadGateway)
					return
				}
				fallback = live.Items
			}
		}
		total = countTotal
		nextStart = startIndex + len(rows) + len(fallback)

	case filterUnset:
		excluded, err := s.curation.AllCategorizedIDsForProfile(r.Context(), profileID)
		if err != nil {
			s.logger.Error().Err(err).Msg("load excluded ids")
			http.Error(w, "failed to load items", http.StatusInternalServerError)
			return
		}
		rows, total, nextStart, err = s.pageUnsetForProfile(r.Context(), itemTypes, search, limit, startIndex, excluded)
		if err != nil {
			s.logger.Error().Err(err).Msg("page items")
			http.Error(w, "failed to load items", http.StatusInternalServerError)
			return
		}
		hasMore = nextStart < total

	default:
		// Default listing: no state filter, no tag filter. Serve
		// from cache ordered by sort_name. Search applies as a
		// substring match on Name (case-insensitive) directly on
		// the cached rows.
		all, err := s.cache.ListByType(r.Context(), itemTypes)
		if err != nil {
			s.logger.Error().Err(err).Msg("cache list items")
			http.Error(w, "failed to list items", http.StatusInternalServerError)
			return
		}
		if search != "" {
			filtered := all[:0]
			needle := strings.ToLower(search)
			for _, row := range all {
				if strings.Contains(strings.ToLower(row.Name), needle) {
					filtered = append(filtered, row)
				}
			}
			all = filtered
		}
		total = len(all)
		end := startIndex + limit
		if startIndex > len(all) {
			rows = nil
		} else {
			if end > len(all) {
				end = len(all)
			}
			rows = all[startIndex:end]
		}
		nextStart = startIndex + len(rows)
		hasMore = nextStart < total
	}

enrich:
	idList := make([]string, 0, len(rows)+len(fallback))
	for _, r := range rows {
		idList = append(idList, r.ID)
	}
	for _, it := range fallback {
		idList = append(idList, it.ID)
	}
	states, err := s.curation.GetStatesForItems(r.Context(), profileID, idList)
	if err != nil {
		s.logger.Error().Err(err).Msg("fetch states")
		http.Error(w, "failed to load states", http.StatusInternalServerError)
		return
	}
	tagSets, err := s.curation.GetTagsForItems(r.Context(), idList)
	if err != nil {
		s.logger.Error().Err(err).Msg("fetch tags")
		http.Error(w, "failed to load tags", http.StatusInternalServerError)
		return
	}

	enriched := make([]adminItemListDTO, 0, len(rows)+len(fallback))
	for _, row := range rows {
		var statePtr *curation.State
		if st, ok := states[row.ID]; ok {
			statePtr = &st
		}
		var suggestPtr *curation.Suggestion
		if withSuggest {
			sug := curation.Suggest(rowAsItem(row))
			suggestPtr = &sug
		}
		enriched = append(enriched, adminItemListDTOFromCache(row, statePtr, tagSets[row.ID], suggestPtr))
	}
	for _, it := range fallback {
		var statePtr *curation.State
		if st, ok := states[it.ID]; ok {
			statePtr = &st
		}
		var suggestPtr *curation.Suggestion
		if withSuggest {
			sug := curation.Suggest(it)
			suggestPtr = &sug
		}
		enriched = append(enriched, adminItemListDTOFromJellyfin(it, statePtr, tagSets[it.ID], suggestPtr))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"Items":            enriched,
		"TotalRecordCount": total,
		"ReturnedCount":    len(enriched),
		"StartIndex":       startIndex,
		"NextStartIndex":   nextStart,
		"HasMore":          hasMore,
		"ProfileId":        profileID,
	})
}

// loadRowsByIDs is the cache-first batch lookup. Returns the cached
// rows in the same order as ids (skipping any id the cache doesn't
// cover) plus the list of ids the caller still needs to live-fetch
// from Jellyfin.
func (s *Server) loadRowsByIDs(ctx context.Context, ids []string) ([]itemcache.Row, []string, error) {
	if s.cache == nil {
		return nil, ids, nil
	}
	byID, err := s.cache.GetMany(ctx, ids)
	if err != nil {
		return nil, nil, err
	}
	rows := make([]itemcache.Row, 0, len(ids))
	var missing []string
	for _, id := range ids {
		if r, ok := byID[id]; ok {
			rows = append(rows, r)
			continue
		}
		missing = append(missing, id)
	}
	return rows, missing, nil
}

// filterRowsByType drops cache rows whose Type isn't in the allowed
// set. Used by tag-filter listings where the tagId can carry items
// the type filter wants to exclude.
func filterRowsByType(rows []itemcache.Row, allowed map[string]struct{}) []itemcache.Row {
	if len(allowed) == 0 {
		return rows
	}
	out := rows[:0]
	for _, r := range rows {
		if _, ok := allowed[r.Type]; ok {
			out = append(out, r)
		}
	}
	return out
}

// rowAsItem rebuilds enough of a jellyfin.Item to feed curation.Suggest,
// which only reads Name / Type / Genres / Studios / OfficialRating.
// Genres + Studios aren't cached, so the suggestion will be slightly
// less informed than the live-Jellyfin path - acceptable because
// suggestions are advisory and the caller can re-trigger via the
// single-item detail endpoint when fidelity matters.
func rowAsItem(r itemcache.Row) jellyfin.Item {
	return jellyfin.Item{
		ID:             r.ID,
		Name:           r.Name,
		Type:           r.Type,
		OfficialRating: r.OfficialRating,
		ProductionYear: r.ProductionYear,
		RunTimeTicks:   r.RunTimeTicks,
	}
}


// handleAdminGetItem returns a single decorated item (state + tags
// + suggestion). Used by /items/:id (manage-item deep-link) which
// needs to fetch by id rather than scanning a paginated list.
func (s *Server) handleAdminGetItem(w http.ResponseWriter, r *http.Request) {
	profileID, ok := requireProfileID(w, r)
	if !ok {
		return
	}
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
		s.logger.Error().Err(err).Str("id", id).Msg("get item")
		http.Error(w, "failed to load item", http.StatusBadGateway)
		return
	}
	states, _ := s.curation.GetStatesForItems(r.Context(), profileID, []string{id})
	tagSets, _ := s.curation.GetTagsForItems(r.Context(), []string{id})
	var statePtr *curation.State
	if st, ok := states[id]; ok {
		statePtr = &st
	}
	dto := toAdminItemDTO(*item, statePtr, tagSets[id], nil)
	// The single-item endpoint historically omits DateCreated; the
	// items list endpoint always emits it. Preserve that split.
	dto.DateCreated = nil
	writeJSON(w, http.StatusOK, dto)
}

// pageUnsetForProfile walks the cached item catalog and returns rows
// that have no state row for the given profile. This is the bulk
// view's data source - the cache-driven version of what used to be a
// 14-18s Jellyfin paging loop. Total reflects the count of unset
// items across the whole library (not just the rows actually returned
// on this page), matching the prior contract.
//
// search applies as a case-insensitive substring match on Name
// directly on the cached rows.
func (s *Server) pageUnsetForProfile(
	ctx context.Context,
	itemTypes []string,
	search string,
	limit, startIndex int,
	excluded map[string]struct{},
) ([]itemcache.Row, int, int, error) {
	all, err := s.cache.ListByType(ctx, itemTypes)
	if err != nil {
		return nil, 0, startIndex, err
	}
	// Strip categorized + (when search is set) non-matching items
	// before pagination so startIndex / total reflect the user-visible
	// set, not the cache's full size.
	needle := strings.ToLower(strings.TrimSpace(search))
	filtered := all[:0]
	for _, row := range all {
		if _, skip := excluded[row.ID]; skip {
			continue
		}
		if needle != "" && !strings.Contains(strings.ToLower(row.Name), needle) {
			continue
		}
		filtered = append(filtered, row)
	}
	total := len(filtered)
	if startIndex >= total {
		return nil, total, total, nil
	}
	end := startIndex + limit
	if end > total {
		end = total
	}
	return filtered[startIndex:end], total, end, nil
}

type setStateRequest struct {
	ProfileID int64   `json:"profileId"`
	State     *string `json:"state"` // null clears the row (back to unset)
}

func (s *Server) handleAdminSetState(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	req, err := decodeJSON[setStateRequest](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.ProfileID <= 0 {
		http.Error(w, "profileId required", http.StatusBadRequest)
		return
	}
	var st *curation.State
	if req.State != nil {
		parsed, err := curation.ParseState(*req.State)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		st = &parsed
	}
	if _, err := s.curation.SetState(r.Context(), id, req.ProfileID, st, sessionUserID(r)); err != nil {
		s.logger.Error().Err(err).Str("id", id).Int64("profile_id", req.ProfileID).Msg("set state")
		http.Error(w, "failed to set state", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type bulkStateRequest struct {
	ProfileID int64    `json:"profileId"`
	ItemIDs   []string `json:"itemIds"`
	State     *string  `json:"state"`
}

func (s *Server) handleAdminBulkState(w http.ResponseWriter, r *http.Request) {
	req, err := decodeJSON[bulkStateRequest](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.ProfileID <= 0 {
		http.Error(w, "profileId required", http.StatusBadRequest)
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
	var st *curation.State
	if req.State != nil {
		parsed, err := curation.ParseState(*req.State)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		st = &parsed
	}
	updated, err := s.curation.SetStateBulk(r.Context(), req.ItemIDs, req.ProfileID, st, sessionUserID(r))
	if err != nil {
		s.logger.Error().Err(err).Msg("bulk set state")
		http.Error(w, "failed to apply bulk", http.StatusInternalServerError)
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
	// profileId is optional here; 0 = all profiles.
	var profileID int64
	if v := r.URL.Query().Get("profileId"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			profileID = n
		}
	}
	hist, err := s.curation.RecentHistory(r.Context(), profileID, limit)
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
		ID        int64   `json:"id"`
		ItemID    string  `json:"itemId"`
		ItemName  string  `json:"itemName"`
		ProfileID int64   `json:"profileId"`
		FromState *string `json:"fromState"`
		ToState   *string `json:"toState"`
		ChangedBy string  `json:"changedBy,omitempty"`
		ChangedAt int64   `json:"changedAt"`
	}
	out := make([]historyResponse, 0, len(hist))
	for _, h := range hist {
		name, ok := names[h.ItemID]
		if !ok {
			name = "(unknown)"
		}
		entry := historyResponse{
			ID:        h.ID,
			ItemID:    h.ItemID,
			ItemName:  name,
			ProfileID: h.ProfileID,
			ChangedBy: h.ChangedBy,
			ChangedAt: h.ChangedAt.Unix(),
		}
		if h.FromState != nil {
			s := string(*h.FromState)
			entry.FromState = &s
		}
		if h.ToState != nil {
			s := string(*h.ToState)
			entry.ToState = &s
		}
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": out})
}

// handleAdminReconcile walks every categorization, asks Jellyfin which
// item ids still resolve, and tombstones (or untombstones) the rest via
// curation.Store.Reconcile. Manual trigger only - no scheduler yet. Safe
// to invoke at any time; the reconciler is service-account scoped and
// idempotent for unchanged rows.
//
// Response shape: {"checked": N, "marked": N, "cleared": N}.
func (s *Server) handleAdminReconcile(w http.ResponseWriter, r *http.Request) {
	checked, marked, cleared, err := s.curation.Reconcile(r.Context(), s.reconcileLookup)
	if err != nil {
		s.logger.Error().Err(err).Msg("reconcile orphan categorizations")
		http.Error(w, "reconcile failed", http.StatusBadGateway)
		return
	}
	s.logger.Info().
		Int("checked", checked).
		Int("marked", marked).
		Int("cleared", cleared).
		Str("changed_by", sessionUserID(r)).
		Msg("reconcile complete")
	writeJSON(w, http.StatusOK, map[string]int{
		"checked": checked,
		"marked":  marked,
		"cleared": cleared,
	})
}

// reconcileLookup is the curation.Reconcile lookup func wired against
// the service-account Jellyfin client. Shared between the admin
// maintenance endpoint and the startup self-heal so both apply the
// same "is this id still in Jellyfin?" predicate.
func (s *Server) reconcileLookup(ctx context.Context, ids []string) (map[string]struct{}, error) {
	if len(ids) == 0 {
		return map[string]struct{}{}, nil
	}
	res, err := s.jellyfin.GetItems(ctx, jellyfin.ItemsFilter{IDs: ids})
	if err != nil {
		return nil, err
	}
	found := make(map[string]struct{}, len(res.Items))
	for _, it := range res.Items {
		found[it.ID] = struct{}{}
	}
	return found, nil
}

// RunStartupReconcile sweeps the categorizations table once at boot and
// tombstones rows whose Jellyfin item ids no longer resolve (and clears
// tombstones on items that have come back). Idempotent and safe to run
// concurrently with the manual /api/admin/maintenance/reconcile
// endpoint - MarkOrphan / ClearOrphan are individually idempotent.
//
// Why this exists: the kids library handler computes its ETag from
// curation DB state alone, so a Jellyfin item disappearing without a
// categorization flip never invalidates the kid client's IndexedDB
// cache. Stale cached pages then render dead poster URLs as 404 black
// tiles. Reconciling at boot bumps ProfileMaxSetAt for any profile
// holding a now-orphaned id, busting those caches on the next request
// the kid client makes.
//
// Errors are logged, not returned: this is a best-effort background
// refresh, and the daemon should keep serving even if Jellyfin is
// temporarily unreachable at boot.
func (s *Server) RunStartupReconcile(ctx context.Context) {
	checked, marked, cleared, err := s.curation.Reconcile(ctx, s.reconcileLookup)
	if err != nil {
		s.logger.Warn().Err(err).Msg("startup reconcile failed")
		return
	}
	s.logger.Info().
		Int("checked", checked).
		Int("marked", marked).
		Int("cleared", cleared).
		Msg("startup reconcile complete")
}

// handleAdminStream returns the Jellyfin HLS manifest URL for the requested
// item as JSON. We don't 302-redirect: hls.js needs to know the URL is HLS
// so it engages instead of letting the browser try to natively decode the
// manifest.
//
// Series have no MediaSources of their own, so Jellyfin's HLS endpoint 500s
// when handed a Series id directly. When the requested item is a Series,
// fall back to its first episode so the admin's preview modal works on
// shows the same way it does on movies. Series name + episode name both
// returned so the UI can show what's actually playing.
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

	streamID := id
	streamName := item.Name
	itemType := item.Type
	seriesName := ""
	streamItem := item
	if item.Type == "Series" {
		ep, err := s.jellyfin.FirstEpisodeOfSeries(r.Context(), id)
		if err != nil {
			if errors.Is(err, jellyfin.ErrNotFound) {
				http.Error(w, "series has no episodes", http.StatusNotFound)
				return
			}
			s.logger.Error().Err(err).Str("series_id", id).Msg("resolve series for preview")
			http.Error(w, "failed to resolve episode for series", http.StatusBadGateway)
			return
		}
		streamID = ep.ID
		streamName = ep.Name
		seriesName = item.Name
		itemType = ep.Type
		streamItem = ep
	}

	audioIdx := s.preferredAudioStreamIndex(r.Context(), streamItem, r.URL.Query().Get("profileId"))

	writeJSON(w, http.StatusOK, map[string]string{
		"streamUrl":  s.jellyfin.StreamURLWithAudio(streamID, "", audioIdx),
		"itemId":     streamID,
		"itemName":   streamName,
		"itemType":   itemType,
		"seriesName": seriesName,
	})
}

// preferredAudioStreamIndex picks the audio stream that best matches the
// profile's default language. Returns 0 when no profileId is supplied,
// the profile has no language preference, or the preferred language has
// no track in the item; in those cases callers should use Jellyfin's
// default-track selection. profileIDStr is the raw query value to keep
// the call sites tidy; bad values are silently treated as "no profile".
func (s *Server) preferredAudioStreamIndex(ctx context.Context, item *jellyfin.Item, profileIDStr string) int {
	if profileIDStr == "" || item == nil {
		return 0
	}
	profileID, err := strconv.ParseInt(profileIDStr, 10, 64)
	if err != nil || profileID <= 0 {
		return 0
	}
	prof, err := s.curation.GetProfile(ctx, profileID)
	if err != nil || prof.DefaultLanguage == "" {
		return 0
	}
	idx, ok := item.AudioStreamIndexForLanguage(prof.DefaultLanguage)
	if !ok {
		return 0
	}
	return idx
}

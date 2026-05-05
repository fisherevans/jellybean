package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

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
//   profileId  - REQUIRED. Which profile's state to surface and filter by.
//   type       - Jellyfin item type (default Movie)
//   limit      - 1..200, default 50
//   startIndex - pagination offset, default 0
//   search     - substring on name (passed through to Jellyfin's
//                searchTerm), capped at 200 chars
//   state      - visible | hidden | unset; if set, only items in that
//                state for this profile are returned
//   suggest    - "true" to enrich each item with an auto-categorization
//                suggestion
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

	var (
		items     []jellyfin.Item
		total     int
		hasMore   bool
		nextStart = startIndex
	)

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
			res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{IDs: ids})
			if err != nil {
				s.logger.Error().Err(err).Msg("get items by ids (tag filter)")
				http.Error(w, "failed to load items", http.StatusBadGateway)
				return
			}
			items = res.Items
			total = res.TotalRecordCount
		}
		// Honor the type filter: drop items whose Type isn't in the
		// allowed set.
		if len(items) > 0 {
			allowed := map[string]struct{}{}
			for _, t := range itemTypes {
				allowed[t] = struct{}{}
			}
			kept := items[:0]
			for _, it := range items {
				if _, ok := allowed[it.Type]; ok {
					kept = append(kept, it)
				}
			}
			items = kept
			total = len(items)
		}
		nextStart = startIndex + len(items)
		// Skip the state-filter switch below when tagId is in play.
		goto enrich
	}

	switch wantState {
	case filterVisible, filterHidden:
		st := curation.StateVisible
		if wantState == filterHidden {
			st = curation.StateHidden
		}
		if search != "" {
			// With a name search active, ignore the curation
			// pagination and instead let Jellyfin do the substring
			// match, then filter the result by the requested
			// curation state. This is the path the Browse search
			// box hits when a state filter is also applied.
			res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{
				IncludeItemTypes: itemTypes,
				Recursive:        true,
				Limit:            500,
				SearchTerm:       search,
				SortBy:           "SortName",
				SortOrder:        "Ascending",
			})
			if err != nil {
				s.logger.Error().Err(err).Msg("search items")
				http.Error(w, "failed to search items", http.StatusBadGateway)
				return
			}
			ids := make([]string, len(res.Items))
			for i, it := range res.Items {
				ids[i] = it.ID
			}
			states, err := s.curation.GetStatesForItems(r.Context(), profileID, ids)
			if err != nil {
				s.logger.Error().Err(err).Msg("get states")
				http.Error(w, "failed to load states", http.StatusInternalServerError)
				return
			}
			matching := make([]jellyfin.Item, 0, len(res.Items))
			for _, it := range res.Items {
				if string(states[it.ID]) == string(st) {
					matching = append(matching, it)
				}
			}
			total = len(matching)
			if startIndex < len(matching) {
				end := startIndex + limit
				if end > len(matching) {
					end = len(matching)
				}
				items = matching[startIndex:end]
			}
			hasMore = startIndex+len(items) < total
			nextStart = startIndex + len(items)
		} else {
			// Pull one extra to know if there's a next page, plus the
			// real total of categorized items for that state. The
			// Jellyfin TotalRecordCount reflects the IDs we asked
			// about, not the full library state, so we can't use it
			// for the meta count.
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
				res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{IDs: ids})
				if err != nil {
					s.logger.Error().Err(err).Msg("get items by ids")
					http.Error(w, "failed to load items", http.StatusBadGateway)
					return
				}
				items = res.Items
			}
			total = countTotal
			nextStart = startIndex + len(items)
		}

	case filterUnset:
		excluded, err := s.curation.AllCategorizedIDsForProfile(r.Context(), profileID)
		if err != nil {
			s.logger.Error().Err(err).Msg("load excluded ids")
			http.Error(w, "failed to load items", http.StatusInternalServerError)
			return
		}
		items, total, nextStart, err = s.pageUnsetForProfile(r.Context(), itemTypes, search, limit, startIndex, excluded)
		if err != nil {
			s.logger.Error().Err(err).Msg("page items")
			http.Error(w, "failed to load items", http.StatusBadGateway)
			return
		}
		hasMore = nextStart < total

	default:
		res, err := s.jellyfin.GetItems(r.Context(), jellyfin.ItemsFilter{
			IncludeItemTypes: itemTypes,
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

enrich:
	idList := make([]string, len(items))
	for i, it := range items {
		idList[i] = it.ID
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
			"DateCreated":    it.DateCreated,
			"ImageTags":      it.ImageTags,
			"AudioLanguage":  it.PrimaryAudioLanguage(),
			"AudioLanguages": it.AudioLanguages(),
		}
		if st, ok := states[it.ID]; ok {
			row["State"] = string(st)
		} else {
			row["State"] = nil
		}
		// Decorate with the item's tag set so the kebab UI on each
		// tile can render checkboxes without an extra round trip.
		if tags, ok := tagSets[it.ID]; ok {
			compact := make([]map[string]any, 0, len(tags))
			for _, tg := range tags {
				compact = append(compact, map[string]any{
					"id":   tg.ID,
					"name": tg.Name,
				})
			}
			row["Tags"] = compact
		} else {
			row["Tags"] = []map[string]any{}
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
		"ProfileId":        profileID,
	})
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
	row := map[string]any{
		"Id":             item.ID,
		"Name":           item.Name,
		"Type":           item.Type,
		"OfficialRating": item.OfficialRating,
		"Genres":         item.Genres,
		"Studios":        item.Studios,
		"ProductionYear": item.ProductionYear,
		"ImageTags":      item.ImageTags,
		"AudioLanguage":  item.PrimaryAudioLanguage(),
		"AudioLanguages": item.AudioLanguages(),
	}
	if st, ok := states[id]; ok {
		row["State"] = string(st)
	} else {
		row["State"] = nil
	}
	tagsJSON := make([]map[string]any, 0)
	if tags, ok := tagSets[id]; ok {
		for _, tg := range tags {
			tagsJSON = append(tagsJSON, map[string]any{"id": tg.ID, "name": tg.Name})
		}
	}
	row["Tags"] = tagsJSON
	writeJSON(w, http.StatusOK, row)
}

// pageUnsetForProfile walks Jellyfin's catalog and returns items that have
// no state row for the given profile. This is the bulk view's data source.
func (s *Server) pageUnsetForProfile(
	ctx context.Context,
	itemTypes []string,
	search string,
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
			IncludeItemTypes: itemTypes,
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
	var req setStateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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
	var req bulkStateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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
	lookup := func(ctx context.Context, ids []string) (map[string]struct{}, error) {
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
	checked, marked, cleared, err := s.curation.Reconcile(r.Context(), lookup)
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

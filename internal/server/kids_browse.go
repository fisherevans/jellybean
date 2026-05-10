package server

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/browse"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// Kids browse endpoint (M8 #47). Routes through the resolver in
// internal/browse, then decorates each row's item ids with full
// Jellyfin item bodies so the kid client can render tiles directly.

type browseRowResponse struct {
	RowID    int64  `json:"rowId"`
	Type     string `json:"type"`
	Title    string `json:"title"`
	SubTitle string `json:"subtitle,omitempty"`
	// Icon is an optional Phosphor icon name that the kid client
	// renders next to the row title. Set by the resolver:
	// "Heart" for favorites, the tag's icon for tag/tag_fanout
	// when configured, "" otherwise.
	Icon string `json:"icon,omitempty"`
	// HasMore is true when more items exist beyond what was
	// returned. The kid client renders a "Load more" terminal
	// button when true and "Loop back to start" when false.
	// Currently set by random_unwatched + recently_added; other
	// row types stay false.
	HasMore bool         `json:"hasMore,omitempty"`
	Items   []browseItem `json:"items"`
}

// browseItem is the slim per-tile payload shipped to the kid client.
// Used to be []jellyfin.Item, but the client only reads a handful of
// fields and the full jellyfin.Item includes MediaStreams, Genres,
// Studios, etc. - over 80% of the wire weight. JSON keys keep the
// capitalized Jellyfin shape so the existing client TypeScript types
// still match.
//
// DateCreated is included so the kid client's date-bucketing utility
// (Library + TagDetail recency sorts) can group items by "Added today
// / this week / earlier" without a second round-trip.
//
// ProductionYear + RunTimeTicks are included so the M8 hero-detail
// panel can render the year + runtime line synchronously off the
// focused tile without a follow-up fetch. ~10 extra bytes per tile.
type browseItem struct {
	ID             string                 `json:"Id"`
	Name           string                 `json:"Name"`
	Type           string                 `json:"Type"`
	DateCreated    string                 `json:"DateCreated,omitempty"`
	ProductionYear int                    `json:"ProductionYear,omitempty"`
	RunTimeTicks   int64                  `json:"RunTimeTicks,omitempty"`
	ImageTags      *browseImageTags       `json:"ImageTags,omitempty"`
	UserData       *jellyfin.ItemUserData `json:"UserData,omitempty"`
}

// browseImageTags carries only the Primary tag - the kid client uses
// it to build the image proxy URL (the value is part of the cache
// key for content-addressed posters). Backdrop / Logo / Thumb are
// never read on the browse page.
type browseImageTags struct {
	Primary string `json:"Primary,omitempty"`
}

// toBrowseItem trims a Jellyfin Item down to what the kid browse
// page renders.
func toBrowseItem(it jellyfin.Item) browseItem {
	out := browseItem{
		ID:             it.ID,
		Name:           it.Name,
		Type:           it.Type,
		DateCreated:    it.DateCreated,
		ProductionYear: it.ProductionYear,
		RunTimeTicks:   it.RunTimeTicks,
		UserData:       it.UserData,
	}
	if it.ImageTags.Primary != "" {
		out.ImageTags = &browseImageTags{Primary: it.ImageTags.Primary}
	}
	return out
}

type browseResponse struct {
	LayoutID   int64               `json:"layoutId"`
	LayoutName string              `json:"layoutName"`
	ProfileID  int64               `json:"profileId"`
	Rows       []browseRowResponse `json:"rows"`
}

// browseContext bundles the persistent dependencies the resolver needs.
// Cheap enough to construct per request; we're not memoizing on Server
// because the curation store + jellyfin client are already stable
// references on Server itself.
//
// Warn forwards the resolver's non-fatal warnings (unknown row type,
// per-row resolve errors that get swallowed) into our zerolog logger
// without making internal/browse import zerolog.
func (s *Server) browseContext() *browse.Context {
	return &browse.Context{
		Store: s.curation,
		Jelly: s.jellyfin,
		Warn: func(msg string, kv ...any) {
			ev := s.logger.Warn()
			for i := 0; i+1 < len(kv); i += 2 {
				key, ok := kv[i].(string)
				if !ok {
					continue
				}
				switch v := kv[i+1].(type) {
				case error:
					ev = ev.Err(v)
				case string:
					ev = ev.Str(key, v)
				case int:
					ev = ev.Int(key, v)
				case int64:
					ev = ev.Int64(key, v)
				default:
					ev = ev.Interface(key, v)
				}
			}
			ev.Msg(msg)
		},
	}
}

// handleKidsBrowse resolves the kid's layout into renderable rows.
// Auth: kid bearer (preferred) or admin cookie + ?profileId=.
func (s *Server) handleKidsBrowse(w http.ResponseWriter, r *http.Request) {
	kc, profileID := KidsContextFromRequest(r)
	s.respondBrowse(w, r, profileID, 0, kc.kidIDForBrowse(), kc.JellyfinUserID, kc.JellyfinToken)
}

// handleKidsBrowseRow re-resolves a single layout row at a higher
// max_items. Backs the kid client's "Load more" button on discover
// rows (random_unwatched, recently_added). Returns the same shape as
// one entry of /api/kids/browse rows[].
//
// GET /api/kids/browse/row/:rowId?limit=N
func (s *Server) handleKidsBrowseRow(w http.ResponseWriter, r *http.Request) {
	kc, profileID := KidsContextFromRequest(r)
	rowID, err := strconv.ParseInt(mux.Vars(r)["rowId"], 10, 64)
	if err != nil || rowID <= 0 {
		http.Error(w, "bad rowId", http.StatusBadRequest)
		return
	}
	// limit caps at 500 - hard ceiling so a malicious or buggy
	// client can't ask for the whole library at once.
	limit := 40
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, parseErr := strconv.Atoi(l); parseErr == nil && n > 0 {
			limit = n
			if limit > 500 {
				limit = 500
			}
		}
	}
	kidID := kc.kidIDForBrowse()
	if kidID == 0 && kc.JellyfinUserID != "" {
		if kid, err := s.curation.FindKidByJellyfinUser(r.Context(), kc.JellyfinUserID); err == nil {
			kidID = kid.ID
		}
	}
	s.respondBrowseRow(w, r, profileID, rowID, limit, kidID, kc.JellyfinUserID, kc.JellyfinToken)
}

// respondBrowseRow runs the resolver for a single row at the
// requested limit and writes the result as a single browseRowResponse.
func (s *Server) respondBrowseRow(
	w http.ResponseWriter, r *http.Request,
	profileID, rowID int64, limit int,
	kidID int64, userID, userTok string,
) {
	ctx := r.Context()
	profile, err := s.curation.GetProfile(ctx, profileID)
	if err != nil {
		if errors.Is(err, curation.ErrProfileNotFound) {
			http.Error(w, "profile not found", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Msg("browse row get profile")
		http.Error(w, "failed to load profile", http.StatusInternalServerError)
		return
	}
	layoutID := s.layoutIDForProfile(ctx, profile.ID)
	if layoutID <= 0 {
		def, err := s.curation.GetDefaultLayout(ctx)
		if err != nil {
			s.logger.Error().Err(err).Msg("default layout missing")
			http.Error(w, "no layout available", http.StatusInternalServerError)
			return
		}
		layoutID = def.ID
	}
	layout, err := s.curation.GetLayoutWithRows(ctx, layoutID)
	if err != nil {
		s.logger.Error().Err(err).Int64("layout_id", layoutID).Msg("get layout")
		http.Error(w, "failed to load layout", http.StatusInternalServerError)
		return
	}
	var target *curation.LayoutRow
	for i := range layout.Rows {
		if layout.Rows[i].ID == rowID {
			target = &layout.Rows[i]
			break
		}
	}
	if target == nil {
		http.Error(w, "row not found", http.StatusNotFound)
		return
	}
	if !browse.IsSupportedRowType(target.Type) {
		http.Error(w, "row type not supported", http.StatusBadRequest)
		return
	}
	resolved, err := browse.ResolveRow(ctx, s.browseContext(), profile, layout, *target, limit, kidID, userID, userTok)
	if err != nil {
		s.logger.Error().Err(err).Int64("row_id", rowID).Msg("browse row resolve")
		writeUpstreamError(w, err, "failed to load row")
		return
	}
	// tag_fanout returns multiple rows; load-more isn't supported
	// for it (each fanout row would need its own rowId). Return
	// the first one so the call doesn't 500, but HasMore stays false.
	if len(resolved) == 0 {
		writeJSON(w, http.StatusOK, browseRowResponse{
			RowID: rowID, Type: string(target.Type), Items: []browseItem{},
		})
		return
	}
	rr := resolved[0]
	idSet := map[string]struct{}{}
	for _, id := range rr.ItemIDs {
		idSet[id] = struct{}{}
	}
	ids := make([]string, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	itemsByID := map[string]jellyfin.Item{}
	if len(ids) > 0 {
		batched, err := s.jellyfin.GetItemsByIDsBatched(ctx, ids, userTok)
		if err != nil {
			s.logger.Error().Err(err).Msg("browse row decorate")
			writeUpstreamError(w, err, "failed to load items")
			return
		}
		for _, it := range batched {
			itemsByID[it.ID] = it
		}
	}
	items := make([]jellyfin.Item, 0, len(rr.ItemIDs))
	for _, id := range rr.ItemIDs {
		if it, ok := itemsByID[id]; ok {
			items = append(items, it)
		}
	}
	applyPostFetchSort(items, rr)
	if rr.MaxItems > 0 && len(items) > rr.MaxItems {
		items = items[:rr.MaxItems]
	}
	slim := make([]browseItem, len(items))
	for i, it := range items {
		slim[i] = toBrowseItem(it)
	}
	writeJSON(w, http.StatusOK, browseRowResponse{
		RowID:    rr.RowID,
		Type:     string(rr.Type),
		Title:    rr.Title,
		SubTitle: rr.SubTitle,
		Icon:     rr.Icon,
		HasMore:  rr.HasMore,
		Items:    slim,
	})
}

// kidIDForBrowse returns the kid id when the request was bearer-authed,
// 0 when admin-authed (admin previewing as a profile, not a specific
// kid). Favorites resolution is per-kid and skips when 0.
func (kc *kidsContext) kidIDForBrowse() int64 {
	// kc.ProfileID is set on the bearer-auth path from the kid record;
	// admin path leaves it 0. We need the kid id specifically though,
	// not the profile - look it up via curation. The store call is
	// wrapped in a separate helper to keep the field name out of the
	// hot path.
	//
	// For v1, kid-id-for-favorites comes from the bearer's user id
	// rather than ProfileID. The handler does the lookup; this method
	// stays a placeholder so the call site below stays uniform.
	return 0
}

// respondBrowse is the shared resolver -> decorate -> writeJSON
// pipeline used by both /api/kids/browse and the admin preview route.
//
// layoutID == 0 -> use the profile's assigned layout (or default).
// kidID == 0 -> favorites row resolves to empty (admin preview path).
func (s *Server) respondBrowse(
	w http.ResponseWriter, r *http.Request,
	profileID, layoutID, kidID int64,
	userID, userTok string,
) {
	ctx := r.Context()
	profile, err := s.curation.GetProfile(ctx, profileID)
	if err != nil {
		if errors.Is(err, curation.ErrProfileNotFound) {
			http.Error(w, "profile not found", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Msg("browse get profile")
		http.Error(w, "failed to load profile", http.StatusInternalServerError)
		return
	}

	// Resolve the layout id: explicit -> profile.layout_id ->
	// default. NULL profile.layout_id (existing migration backfilled
	// it but defensive) falls back to default too.
	if layoutID <= 0 {
		layoutID = s.layoutIDForProfile(ctx, profile.ID)
	}
	if layoutID <= 0 {
		def, err := s.curation.GetDefaultLayout(ctx)
		if err != nil {
			s.logger.Error().Err(err).Msg("default layout missing")
			http.Error(w, "no layout available", http.StatusInternalServerError)
			return
		}
		layoutID = def.ID
	}
	layout, err := s.curation.GetLayoutWithRows(ctx, layoutID)
	if err != nil {
		s.logger.Error().Err(err).Int64("layout_id", layoutID).Msg("get layout")
		http.Error(w, "failed to load layout", http.StatusInternalServerError)
		return
	}

	// On the bearer path we need the kid record's id for the
	// favorites row. Look it up from the user id when the caller
	// didn't supply one explicitly.
	if kidID == 0 && userID != "" {
		kid, err := s.curation.FindKidByJellyfinUser(ctx, userID)
		if err == nil {
			kidID = kid.ID
		}
	}

	resolved, err := browse.Resolve(ctx, s.browseContext(), profile, layout, kidID, userID, userTok)
	if err != nil {
		s.logger.Error().Err(err).Msg("resolve layout")
		http.Error(w, "failed to resolve layout", http.StatusInternalServerError)
		return
	}

	// Decorate every distinct item id in one batch.
	idSet := map[string]struct{}{}
	for _, row := range resolved {
		for _, id := range row.ItemIDs {
			idSet[id] = struct{}{}
		}
	}
	ids := make([]string, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	itemsByID := map[string]jellyfin.Item{}
	if len(ids) > 0 {
		batched, err := s.jellyfin.GetItemsByIDsBatched(ctx, ids, userTok)
		if err != nil {
			s.logger.Error().Err(err).Msg("browse decorate")
			writeUpstreamError(w, err, "failed to load items")
			return
		}
		for _, it := range batched {
			itemsByID[it.ID] = it
		}
	}

	// Assemble rows. Drop rows whose entire item list comes back empty
	// (Jellyfin doesn't know any of them) - the kid client special-
	// cases an empty rows array as the "ask a parent" empty state, so
	// removing degenerate rows keeps the page tight.
	out := make([]browseRowResponse, 0, len(resolved))
	for _, rr := range resolved {
		items := make([]jellyfin.Item, 0, len(rr.ItemIDs))
		for _, id := range rr.ItemIDs {
			if it, ok := itemsByID[id]; ok {
				items = append(items, it)
			}
		}
		// Tag rows + tag_fanout sometimes need their tag-sort to be
		// applied AFTER we have full Item bodies (so we can sort by
		// Name / DateCreated). For those modes the resolver
		// overfetches; cap to MaxItems after sorting so we surface
		// the right "first N" instead of a random N sorted.
		applyPostFetchSort(items, rr)
		if rr.MaxItems > 0 && len(items) > rr.MaxItems {
			items = items[:rr.MaxItems]
		}
		if len(items) == 0 {
			continue
		}
		slim := make([]browseItem, len(items))
		for i, it := range items {
			slim[i] = toBrowseItem(it)
		}
		out = append(out, browseRowResponse{
			RowID:    rr.RowID,
			Type:     string(rr.Type),
			Title:    rr.Title,
			SubTitle: rr.SubTitle,
			Icon:     rr.Icon,
			HasMore:  rr.HasMore,
			Items:    slim,
		})
	}

	writeJSON(w, http.StatusOK, browseResponse{
		LayoutID:   layout.ID,
		LayoutName: layout.Name,
		ProfileID:  profileID,
		Rows:       out,
	})
}

// applyPostFetchSort handles tag-row sorting that needs full Item
// bodies. The resolver's applyTagSort can only do work that fits an
// id list (random shuffle); modes that look at item fields (name,
// date) defer to here.
//
// Dispatch is on row.SortMode, populated by the tag / tag_fanout
// resolvers from row config:
//   - "name"           -> alphabetical by Item.Name
//   - "random"         -> no-op; trust the resolver's shuffled order
//   - "recently_added" -> Item.DateCreated desc; items with empty /
//     unparseable DateCreated sink to the bottom
//     while preserving relative order
//   - "" / unknown     -> no-op (covers non-tag rows + any future
//     resolver that hasn't set SortMode yet)
//
// Other row types (continue_watching, recently_added, random_unwatched,
// favorites, watch_again) leave SortMode empty - their resolver owns
// the order and we don't touch it here.
func applyPostFetchSort(items []jellyfin.Item, row browse.ResolvedRow) {
	if len(items) <= 1 {
		return
	}
	if row.Type != curation.RowTag && row.Type != curation.RowTagFanout {
		return
	}
	switch row.SortMode {
	case "name":
		sort.SliceStable(items, func(i, j int) bool {
			return items[i].Name < items[j].Name
		})
	case "recently_added":
		sort.SliceStable(items, func(i, j int) bool {
			ti, oki := parseItemDate(items[i].DateCreated)
			tj, okj := parseItemDate(items[j].DateCreated)
			// Items with no parseable date go to the bottom.
			if !oki && !okj {
				return false
			}
			if !oki {
				return false
			}
			if !okj {
				return true
			}
			return ti.After(tj)
		})
	}
}

func parseItemDate(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// layoutIDForProfile reads the profile's layout_id directly. We
// don't expose a curation helper because the resolver path is the
// only consumer; if more callers appear it's a one-liner promotion.
func (s *Server) layoutIDForProfile(ctx context.Context, profileID int64) int64 {
	var id int64
	_ = s.db.QueryRowContext(ctx, `SELECT COALESCE(layout_id, 0) FROM profiles WHERE id = ?`, profileID).Scan(&id)
	return id
}

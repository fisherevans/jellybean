package server

import (
	"context"
	"errors"
	"net/http"
	"sort"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// Kids browse endpoint (M8 #47). Routes through the resolver in
// browse_resolver.go, then decorates each row's item ids with full
// Jellyfin item bodies so the kid client can render tiles directly.

type browseRowResponse struct {
	RowID    int64           `json:"rowId"`
	Type     string          `json:"type"`
	Title    string          `json:"title"`
	SubTitle string          `json:"subtitle,omitempty"`
	// Icon is an optional Phosphor icon name that the kid client
	// renders next to the row title. Set by the resolver:
	// "Heart" for favorites, the tag's icon for tag/tag_fanout
	// when configured, "" otherwise.
	Icon  string          `json:"icon,omitempty"`
	Items []jellyfin.Item `json:"items"`
}

type browseResponse struct {
	LayoutID   int64               `json:"layoutId"`
	LayoutName string              `json:"layoutName"`
	ProfileID  int64               `json:"profileId"`
	Rows       []browseRowResponse `json:"rows"`
}

// handleKidsBrowse resolves the kid's layout into renderable rows.
// Auth: kid bearer (preferred) or admin cookie + ?profileId=.
func (s *Server) handleKidsBrowse(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	profileID, msg := s.resolveKidsProfileID(r, kc)
	if msg != "" {
		http.Error(w, msg, http.StatusBadRequest)
		return
	}
	s.respondBrowse(w, r, profileID, 0, kc.kidIDForBrowse(), kc.JellyfinUserID, kc.JellyfinToken)
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

	resolved, err := s.resolveLayout(ctx, profile, layout, kidID, userID, userTok)
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
		// Batch the IDs query. Jellyfin's URL-length limits cap at a
		// few thousand bytes; chunking at 100 keeps us safe.
		const batch = 100
		for i := 0; i < len(ids); i += batch {
			end := i + batch
			if end > len(ids) {
				end = len(ids)
			}
			res, err := s.jellyfin.GetItemsAsUser(ctx, jellyfin.ItemsFilter{
				IDs: ids[i:end],
			}, userTok)
			if err != nil {
				s.logger.Error().Err(err).Msg("browse decorate")
				writeUpstreamError(w, err, "failed to load items")
				return
			}
			for _, it := range res.Items {
				itemsByID[it.ID] = it
			}
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
		// Name etc). The resolver sets ItemIDs in the right order
		// for the "name" sort using Jellyfin's batch return, which
		// happens to be id-order; do the post-sort here.
		applyPostFetchSort(items, rr)
		if len(items) == 0 {
			continue
		}
		out = append(out, browseRowResponse{
			RowID:    rr.RowID,
			Type:     string(rr.Type),
			Title:    rr.Title,
			SubTitle: rr.SubTitle,
			Icon:     rr.Icon,
			Items:    items,
		})
	}

	writeJSON(w, http.StatusOK, browseResponse{
		LayoutID:   layout.ID,
		LayoutName: layout.Name,
		ProfileID:  profileID,
		Rows:       out,
	})
}

// applyPostFetchSort handles row-type-specific sorting that needs
// full Item bodies. For most rows we keep the resolver's order
// (continue_watching is already sorted by Jellyfin, recently_added
// is DateCreated desc, random_unwatched is shuffled). Tag rows fall
// through to alphabetical-by-Name as a sane default.
func applyPostFetchSort(items []jellyfin.Item, row ResolvedRow) {
	if len(items) <= 1 {
		return
	}
	switch row.Type {
	case curation.RowTag, curation.RowTagFanout:
		sort.SliceStable(items, func(i, j int) bool {
			return items[i].Name < items[j].Name
		})
	}
}

// layoutIDForProfile reads the profile's layout_id directly. We
// don't expose a curation helper because the resolver path is the
// only consumer; if more callers appear it's a one-liner promotion.
func (s *Server) layoutIDForProfile(ctx context.Context, profileID int64) int64 {
	var id int64
	_ = s.db.QueryRowContext(ctx, `SELECT COALESCE(layout_id, 0) FROM profiles WHERE id = ?`, profileID).Scan(&id)
	return id
}

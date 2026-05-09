package server

import (
	"math/rand"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// kidsTagPreviewItemCount is the cap on items returned per tag in
// the list response. The CSS strip clips horizontally, so the
// front-end shows whatever fits in the card's preview area;
// returning more than necessary just means the kid sees a wider
// sample on larger screens. Items are randomized server-side so
// every page load surfaces a different slice of the tag.
const kidsTagPreviewItemCount = 16

// kidsTagPreviewItem mirrors the slim browseItem shape used by the
// /api/kids/browse endpoint - just the fields the kid client needs
// to render a poster + title.
type kidsTagPreviewItem struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Type        string                 `json:"type"`
	DateCreated string                 `json:"dateCreated,omitempty"`
	ImageTags   map[string]string      `json:"imageTags,omitempty"`
	UserData    *jellyfin.ItemUserData `json:"userData,omitempty"`
}

type kidsTagsTagResponse struct {
	ID          int64                `json:"id"`
	Name        string               `json:"name"`
	Description string               `json:"description"`
	Icon        string               `json:"icon,omitempty"`
	ItemCount   int                  `json:"itemCount"`
	Items       []kidsTagPreviewItem `json:"items"`
}

type kidsTagsResponse struct {
	Tags []kidsTagsTagResponse `json:"tags"`
}

// handleKidsListTags returns all tags + a small preview of items
// for each tag, filtered to the kid's effective visibility. Powers
// the kid client's /tags page.
//
// Auth: kid bearer (preferred) or admin cookie + ?profileId=.
//
// GET /api/kids/tags
func (s *Server) handleKidsListTags(w http.ResponseWriter, r *http.Request) {
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
	ctx := r.Context()

	tags, err := s.curation.ListTags(ctx, curation.TagSortName)
	if err != nil {
		s.logger.Error().Err(err).Msg("kids list tags")
		http.Error(w, "failed to list tags", http.StatusInternalServerError)
		return
	}

	// Pass 1: per-tag visibility filter to surface up to N item IDs
	// per tag. Build a flat de-duped list of all surviving item IDs
	// so we can batch-fetch them from Jellyfin in one call.
	type tagEntry struct {
		tag       curation.TagWithCount
		visibleID []string
	}
	entries := make([]tagEntry, 0, len(tags))
	idSet := map[string]struct{}{}
	for _, t := range tags {
		rawIDs, err := s.curation.ListItemIDsByTag(ctx, t.ID, 0, 0)
		if err != nil {
			s.logger.Error().Err(err).Int64("tag_id", t.ID).Msg("kids list items by tag")
			continue
		}
		if len(rawIDs) == 0 {
			entries = append(entries, tagEntry{tag: t})
			continue
		}
		states, err := s.curation.EffectiveItemVisibilityBulk(ctx, profileID, rawIDs)
		if err != nil {
			s.logger.Error().Err(err).Int64("tag_id", t.ID).Msg("kids tag visibility")
			continue
		}
		// Collect ALL visible IDs first so the random sample picks
		// from the full set; without this, only the first
		// alphabetical batch would ever surface.
		visible := make([]string, 0, len(rawIDs))
		for _, id := range rawIDs {
			if states[id] == curation.StateVisible {
				visible = append(visible, id)
			}
		}
		// Shuffle then truncate so the kid gets a different slice
		// on every page load. Large library + small preview cap
		// means each visit feels like a fresh peek.
		rand.Shuffle(len(visible), func(i, j int) {
			visible[i], visible[j] = visible[j], visible[i]
		})
		if len(visible) > kidsTagPreviewItemCount {
			visible = visible[:kidsTagPreviewItemCount]
		}
		entries = append(entries, tagEntry{tag: t, visibleID: visible})
		for _, id := range visible {
			idSet[id] = struct{}{}
		}
	}

	// Pass 2: batch fetch Jellyfin items so each preview can render
	// with a poster + title. Empty id list is fine - skip the call.
	itemsByID := map[string]jellyfin.Item{}
	if len(idSet) > 0 {
		ids := make([]string, 0, len(idSet))
		for id := range idSet {
			ids = append(ids, id)
		}
		const batch = 100
		for i := 0; i < len(ids); i += batch {
			end := i + batch
			if end > len(ids) {
				end = len(ids)
			}
			res, err := s.jellyfin.GetItemsAsUser(ctx, jellyfin.ItemsFilter{
				IDs: ids[i:end],
			}, kc.JellyfinToken)
			if err != nil {
				s.logger.Error().Err(err).Msg("kids tags item batch")
				writeUpstreamError(w, err, "failed to load items")
				return
			}
			for _, it := range res.Items {
				itemsByID[it.ID] = it
			}
		}
	}

	// Pass 3: assemble response in the original tag-list order,
	// skipping items the Jellyfin batch didn't return (deleted /
	// permission-filtered).
	// no-store: the preview list is randomized per request so the
	// kid sees a fresh sample each time. Without this header some
	// WebViews (Android TV) fall back to a heuristic cache that
	// pins the first response.
	w.Header().Set("Cache-Control", "no-store, max-age=0")

	out := kidsTagsResponse{Tags: make([]kidsTagsTagResponse, 0, len(entries))}
	for _, e := range entries {
		preview := make([]kidsTagPreviewItem, 0, len(e.visibleID))
		for _, id := range e.visibleID {
			it, ok := itemsByID[id]
			if !ok {
				continue
			}
			imgs := map[string]string{}
			if it.ImageTags.Primary != "" {
				imgs["Primary"] = it.ImageTags.Primary
			}
			pi := kidsTagPreviewItem{
				ID:        it.ID,
				Name:      it.Name,
				Type:      it.Type,
				ImageTags: imgs,
				UserData:  it.UserData,
			}
			preview = append(preview, pi)
		}
		out.Tags = append(out.Tags, kidsTagsTagResponse{
			ID:          e.tag.ID,
			Name:        e.tag.Name,
			Description: e.tag.Description,
			Icon:        e.tag.Icon,
			ItemCount:   e.tag.ItemCount,
			Items:       preview,
		})
	}

	writeJSON(w, http.StatusOK, out)
}

// kidsTagDetailResponse is the body for GET /api/kids/tags/{id}.
// Items are returned in the requested sort order, fully decorated
// from Jellyfin (Name, ImageTags.Primary, UserData) so the kid
// client can render them straight from the response.
type kidsTagDetailResponse struct {
	ID          int64                `json:"id"`
	Name        string               `json:"name"`
	Description string               `json:"description"`
	Icon        string               `json:"icon,omitempty"`
	Sort        string               `json:"sort"`
	// ItemCount is the count of items the response is returning
	// (post type-filter). MovieCount + SeriesCount are unfiltered
	// per-type counts of visible items in this tag, so the kid
	// client can label the empty-state recovery button (e.g. when
	// filter=shows on a movie-only tag) with the count of items
	// the kid would see if they cleared the filter.
	ItemCount   int                  `json:"itemCount"`
	MovieCount  int                  `json:"movieCount"`
	SeriesCount int                  `json:"seriesCount"`
	Items       []kidsTagPreviewItem `json:"items"`
}

// handleKidsTagDetail returns the visible items for a single tag.
// Auth: kid bearer (preferred) or admin cookie + ?profileId=.
//
//	?sort=name           - alphabetical by Item.Name (default)
//	?sort=recently_added - DateCreated desc
//	?sort=recently_watched - UserData.LastPlayedDate desc; items
//	                       the kid hasn't played at all sort last
//	                       (still alphabetical relative to each
//	                       other so the trailing tail is stable).
//	?filter=all|movies|shows - restrict to one Jellyfin item type.
//	                       Default all. Mirrors the Library handler's
//	                       client-driven type filter.
//
// GET /api/kids/tags/{id}
func (s *Server) handleKidsTagDetail(w http.ResponseWriter, r *http.Request) {
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
	tagID, err := strconv.ParseInt(mux.Vars(r)["id"], 10, 64)
	if err != nil || tagID <= 0 {
		http.Error(w, "bad tag id", http.StatusBadRequest)
		return
	}
	ctx := r.Context()

	tag, err := s.curation.GetTag(ctx, tagID)
	if err != nil {
		s.logger.Error().Err(err).Int64("tag_id", tagID).Msg("kids tag detail get tag")
		http.Error(w, "tag not found", http.StatusNotFound)
		return
	}

	rawIDs, err := s.curation.ListItemIDsByTag(ctx, tagID, 0, 0)
	if err != nil {
		s.logger.Error().Err(err).Int64("tag_id", tagID).Msg("kids tag detail list item ids")
		http.Error(w, "failed to load tag items", http.StatusInternalServerError)
		return
	}

	visibleIDs := []string{}
	if len(rawIDs) > 0 {
		states, err := s.curation.EffectiveItemVisibilityBulk(ctx, profileID, rawIDs)
		if err != nil {
			s.logger.Error().Err(err).Int64("tag_id", tagID).Msg("kids tag detail visibility")
			http.Error(w, "failed to resolve visibility", http.StatusInternalServerError)
			return
		}
		for _, id := range rawIDs {
			if states[id] == curation.StateVisible {
				visibleIDs = append(visibleIDs, id)
			}
		}
	}

	itemsByID := map[string]jellyfin.Item{}
	if len(visibleIDs) > 0 {
		const batch = 100
		for i := 0; i < len(visibleIDs); i += batch {
			end := i + batch
			if end > len(visibleIDs) {
				end = len(visibleIDs)
			}
			res, err := s.jellyfin.GetItemsAsUser(ctx, jellyfin.ItemsFilter{
				IDs: visibleIDs[i:end],
			}, kc.JellyfinToken)
			if err != nil {
				s.logger.Error().Err(err).Msg("kids tag detail item batch")
				writeUpstreamError(w, err, "failed to load items")
				return
			}
			for _, it := range res.Items {
				itemsByID[it.ID] = it
			}
		}
	}

	// Type filter applied AFTER the visibility-resolved ID list is
	// hydrated from Jellyfin. The kid client drives this with the
	// shared Filter dropdown (all/movies/shows) and the Library
	// handler uses the same Movie/Series mapping; keep the names in
	// sync so a tag with mixed content filters consistently.
	filterMode := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("filter")))
	switch filterMode {
	case "", "all":
		filterMode = "all"
	case "movies", "shows":
		// ok
	default:
		http.Error(w, "filter must be all, movies, or shows", http.StatusBadRequest)
		return
	}
	allowedType := ""
	switch filterMode {
	case "movies":
		allowedType = "Movie"
	case "shows":
		allowedType = "Series"
	}

	// Per-type unfiltered counts. Computed before applying the type
	// filter so the response can tell the kid client "if you clear
	// the filter, you'll see N movies / M shows."
	var movieCount, seriesCount int
	for _, id := range visibleIDs {
		it, ok := itemsByID[id]
		if !ok {
			continue
		}
		switch it.Type {
		case "Movie":
			movieCount++
		case "Series":
			seriesCount++
		}
	}

	items := make([]jellyfin.Item, 0, len(visibleIDs))
	for _, id := range visibleIDs {
		it, ok := itemsByID[id]
		if !ok {
			continue
		}
		if allowedType != "" && it.Type != allowedType {
			continue
		}
		items = append(items, it)
	}

	sortMode := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("sort")))
	switch sortMode {
	case "recently_added":
		sort.SliceStable(items, func(i, j int) bool {
			return items[i].DateCreated > items[j].DateCreated
		})
	case "recently_watched":
		// Watched items first, by LastPlayedDate desc; unwatched
		// trailing alphabetically. Treat empty LastPlayedDate as
		// "never watched" so they fall to the unwatched bucket.
		sort.SliceStable(items, func(i, j int) bool {
			pi := lastPlayed(items[i])
			pj := lastPlayed(items[j])
			if (pi == "") != (pj == "") {
				return pi != ""
			}
			if pi != pj {
				return pi > pj
			}
			return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
		})
	default:
		sortMode = "name"
		sort.SliceStable(items, func(i, j int) bool {
			return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
		})
	}

	// no-store so each ?sort= request hits the handler again
	// rather than being served from a cached previous response.
	w.Header().Set("Cache-Control", "no-store, max-age=0")

	out := kidsTagDetailResponse{
		ID:          tag.ID,
		Name:        tag.Name,
		Description: tag.Description,
		Icon:        tag.Icon,
		Sort:        sortMode,
		ItemCount:   len(items),
		MovieCount:  movieCount,
		SeriesCount: seriesCount,
		Items:       make([]kidsTagPreviewItem, 0, len(items)),
	}
	for _, it := range items {
		imgs := map[string]string{}
		if it.ImageTags.Primary != "" {
			imgs["Primary"] = it.ImageTags.Primary
		}
		out.Items = append(out.Items, kidsTagPreviewItem{
			ID:          it.ID,
			Name:        it.Name,
			Type:        it.Type,
			DateCreated: it.DateCreated,
			ImageTags:   imgs,
			UserData:    it.UserData,
		})
	}

	writeJSON(w, http.StatusOK, out)
}

func lastPlayed(it jellyfin.Item) string {
	if it.UserData == nil {
		return ""
	}
	return it.UserData.LastPlayedDate
}

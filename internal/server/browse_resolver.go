package server

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"sort"
	"strings"
	"time"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// Browse resolver (M8 #47). Walks a layout's rows + a profile + an
// optional kid id and returns a list of resolved rows ready for the
// kid client to render.
//
// Each row resolves to an ordered list of jellyfin item ids. The
// caller then fetches every id from Jellyfin in one batch and
// decorates the rows with full item bodies. This keeps the resolver
// pure-data + cheap to test, and avoids per-row Jellyfin round trips.
//
// Cache: random_unwatched + tag_fanout (when randomized) memoize their
// orderings in layout_row_cache so refreshes inside a 60-min window
// stay stable.

// ResolvedRow is the resolver's output. Items is the ordered list of
// item ids; the caller swaps to full Item bodies. SubTitle is set on
// fanned-out rows (e.g. tag_fanout produces one ResolvedRow per tag,
// each with the tag's name as SubTitle so the UI can label them).
type ResolvedRow struct {
	RowID    int64
	Type     curation.RowType
	Title    string
	SubTitle string
	// Icon is an optional Phosphor name the kid client renders next
	// to the row title. Set per row type:
	//   - favorites             -> "Heart"
	//   - tag, tag_fanout       -> the tag's icon (when set)
	//   - other                 -> ""
	Icon string
	// HasMore is true when more items exist beyond what's in
	// ItemIDs. Only random_unwatched + recently_added populate
	// this; everything else stays false (terminal "loop back" UI
	// on the kid side).
	HasMore bool
	// SortMode signals to the post-fetch sort step what to do once
	// full Item bodies are loaded. Only the tag / tag_fanout rows
	// populate this; everything else leaves it empty and the post-
	// fetch step is a no-op for them. Values: "name" (alphabetical
	// by Item.Name), "random" (preserve resolver-shuffled order),
	// "recently_added" (Item.DateCreated desc). Empty string =
	// no post-fetch sort.
	SortMode string
	// MaxItems is the post-fetch cap applied AFTER applyPostFetchSort
	// has run. The resolver overfetches when SortMode needs full Item
	// bodies to make a correct cap decision (e.g. "name" needs Names
	// to pick the alphabetically-first N; "recently_added" needs
	// DateCreated to pick the most-recent N). 0 = no post-fetch cap;
	// use ItemIDs as-is.
	MaxItems int
	ItemIDs  []string
}

// browseContext bundles everything the resolver functions need.
// Avoids passing ten parameters down each helper.
type browseContext struct {
	store    *curation.Store
	jelly    *jellyfin.Client
	ctx      context.Context
	profile  curation.Profile
	layout   curation.Layout
	kidID    int64           // 0 when there's no kid (admin preview)
	userID   string          // jellyfin user id; empty in admin preview
	userTok  string          // jellyfin user token; empty in admin preview
	visible  map[string]bool // memoized EffectiveItemVisibility for items we've seen
}

// rowResolver is the per-row-type implementation. Returns the
// ordered list of jellyfin item ids capped to maxItems.
type rowResolver func(b *browseContext, row curation.LayoutRow, cfg map[string]any) ([]ResolvedRow, error)

const (
	defaultMaxItems = 20
	hardMaxItems    = 100
	cacheTTL        = 60 * time.Minute
)

// resolveLayout walks the layout rows in order, returning the
// flattened ResolvedRow list (a single tag_fanout row produces N
// resolved rows). Empty rows are filtered out by the caller after
// item-body decoration so we don't have to re-decide here whether
// the row is "really empty."
func (s *Server) resolveLayout(
	ctx context.Context,
	profile *curation.Profile,
	layout *curation.LayoutWithRows,
	kidID int64,
	userID, userTok string,
) ([]ResolvedRow, error) {
	bc := &browseContext{
		store:   s.curation,
		jelly:   s.jellyfin,
		ctx:     ctx,
		profile: *profile,
		layout:  layout.Layout,
		kidID:   kidID,
		userID:  userID,
		userTok: userTok,
		visible: map[string]bool{},
	}
	resolvers := map[curation.RowType]rowResolver{
		curation.RowContinueWatching: resolveContinueWatching,
		curation.RowFavorites:        resolveFavorites,
		curation.RowTag:              resolveSingleTag,
		curation.RowTagFanout:        resolveTagFanout,
		curation.RowRecentlyAdded:    resolveRecentlyAdded,
		curation.RowRandomUnwatched:  resolveRandomUnwatched,
		curation.RowWatchAgain:       resolveWatchAgain,
	}
	out := []ResolvedRow{}
	for _, row := range layout.Rows {
		fn, ok := resolvers[row.Type]
		if !ok {
			s.logger.Warn().Str("type", string(row.Type)).Msg("unknown row type, skipping")
			continue
		}
		cfg, _ := decodeRowConfig(row.ConfigJSON)
		resolved, err := fn(bc, row, cfg)
		if err != nil {
			s.logger.Warn().Err(err).Str("row_type", string(row.Type)).Int64("row_id", row.ID).Msg("resolve row")
			continue
		}
		out = append(out, resolved...)
	}
	return out, nil
}

// decodeRowConfig parses ConfigJSON into a map for resolver inspection.
// Empty / invalid JSON -> empty map (resolver uses per-key defaults).
func decodeRowConfig(raw string) (map[string]any, error) {
	cfg := map[string]any{}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return cfg, nil
	}
	return cfg, json.Unmarshal([]byte(raw), &cfg)
}

// readMaxItems extracts max_items from row config with sensible
// defaults. Caps at hardMaxItems to keep the response bounded.
func readMaxItems(cfg map[string]any) int {
	n := defaultMaxItems
	if v, ok := cfg["max_items"]; ok {
		switch x := v.(type) {
		case float64:
			if x > 0 {
				n = int(x)
			}
		case int:
			if x > 0 {
				n = x
			}
		}
	}
	if n > hardMaxItems {
		n = hardMaxItems
	}
	return n
}

// readStringConfig returns cfg[key] as a string, or fallback if
// missing / wrong type.
func readStringConfig(cfg map[string]any, key, fallback string) string {
	v, ok := cfg[key]
	if !ok {
		return fallback
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fallback
}

// readIntConfig returns cfg[key] as an int, or fallback if missing.
func readIntConfig(cfg map[string]any, key string, fallback int) int {
	v, ok := cfg[key]
	if !ok {
		return fallback
	}
	if f, ok := v.(float64); ok {
		return int(f)
	}
	if i, ok := v.(int); ok {
		return i
	}
	return fallback
}

// readIntSliceConfig returns cfg[key] as []int64, or empty when
// missing. Used by tag_fanout's include/exclude lists.
func readIntSliceConfig(cfg map[string]any, key string) []int64 {
	v, ok := cfg[key]
	if !ok {
		return nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]int64, 0, len(arr))
	for _, x := range arr {
		switch n := x.(type) {
		case float64:
			out = append(out, int64(n))
		case int:
			out = append(out, int64(n))
		case int64:
			out = append(out, n)
		}
	}
	return out
}

// filterVisible runs EffectiveItemVisibilityBulk on the candidate ids
// and returns only those with state=visible. Memoizes per-context so
// multiple rows in the same browse response don't re-query the same
// items.
func (b *browseContext) filterVisible(itemIDs []string) ([]string, error) {
	if len(itemIDs) == 0 {
		return itemIDs, nil
	}
	missing := make([]string, 0, len(itemIDs))
	for _, id := range itemIDs {
		if _, ok := b.visible[id]; !ok {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		states, err := b.store.EffectiveItemVisibilityBulk(b.ctx, b.profile.ID, missing)
		if err != nil {
			return nil, err
		}
		for _, id := range missing {
			b.visible[id] = states[id] == curation.StateVisible
		}
	}
	out := itemIDs[:0:0]
	for _, id := range itemIDs {
		if b.visible[id] {
			out = append(out, id)
		}
	}
	return out, nil
}

// --- per-type resolvers -------------------------------------------------

func resolveContinueWatching(b *browseContext, row curation.LayoutRow, cfg map[string]any) ([]ResolvedRow, error) {
	max := readMaxItems(cfg)
	if b.userID == "" || b.userTok == "" {
		return []ResolvedRow{newRow(row, "Continue Watching", "", nil)}, nil
	}
	res, err := b.jelly.GetResumeItems(b.ctx, b.userID, b.userTok, max*2)
	if err != nil {
		return nil, err
	}
	// Resume returns the granular position - one entry per episode the
	// kid is mid-way through. We surface series tiles instead so:
	// (a) curation state (categorized at the series level) actually
	// applies - episodes have no per-episode categorization and would
	// otherwise be filtered as hidden;
	// (b) "I'm watching Care Bears" appears once instead of four times
	// when the kid bounced between episodes;
	// (c) clicking a tile lands on /watch/{seriesId} where the
	// accordion auto-selects the in-progress episode.
	ids := resumeIDsForCuration(res.Items)
	visible, err := b.filterVisible(ids)
	if err != nil {
		return nil, err
	}
	return []ResolvedRow{newRow(row, "Continue Watching", "", capItems(visible, max))}, nil
}

// resumeIDsForCuration normalizes a Jellyfin Resume response into the
// list of curation-addressable item ids: Episode ids get rewritten to
// their parent Series id; non-episode items pass through. Order is
// preserved (Jellyfin returns most-recent-activity-first), and
// duplicates collapsed so a kid juggling four episodes of one show
// gets one series tile, not four.
//
// Edge case: if an Episode lacks SeriesID (Jellyfin should always
// populate it but we don't trust the network), we fall back to the
// episode's own id - it'll likely fail visibility, but that's the
// safe default ("if we can't resolve, hide").
func resumeIDsForCuration(items []jellyfin.Item) []string {
	out := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, it := range items {
		id := it.ID
		if it.Type == "Episode" && it.SeriesID != "" {
			id = it.SeriesID
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

func resolveFavorites(b *browseContext, row curation.LayoutRow, cfg map[string]any) ([]ResolvedRow, error) {
	max := readMaxItems(cfg)
	if b.kidID == 0 {
		// Admin preview without a kid context - skip favorites since
		// they're per-kid not per-profile.
		return []ResolvedRow{newRow(row, "Favorites", "", nil)}, nil
	}
	favs, err := b.store.ListKidFavorites(b.ctx, b.kidID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(favs))
	for _, f := range favs {
		ids = append(ids, f.JellyfinItemID)
	}
	visible, err := b.filterVisible(ids)
	if err != nil {
		return nil, err
	}
	return []ResolvedRow{newRow(row, "Favorites", "", capItems(visible, max))}, nil
}

func resolveSingleTag(b *browseContext, row curation.LayoutRow, cfg map[string]any) ([]ResolvedRow, error) {
	max := readMaxItems(cfg)
	tagID := int64(readIntConfig(cfg, "tag_id", 0))
	if tagID <= 0 {
		return nil, fmt.Errorf("tag row missing tag_id")
	}
	tag, err := b.store.GetTag(b.ctx, tagID)
	if err != nil {
		return nil, err
	}
	// Pass 0 for "no limit" so the random shuffle / alphabetical sort
	// considers the full tag, not just the most-recently-tagged 200.
	// For tags larger than that ceiling (e.g. "Funny" with 269 items)
	// a tight limit silently excludes the oldest taggings from
	// selection entirely.
	rawIDs, err := b.store.ListItemIDsByTag(b.ctx, tagID, 0, 0)
	if err != nil {
		return nil, err
	}
	visible, err := b.filterVisible(rawIDs)
	if err != nil {
		return nil, err
	}
	sortMode := readStringConfig(cfg, "sort", "name")
	visible = applyTagSort(b, sortMode, visible, row.ID)
	// Overfetch when the cap decision depends on full Item bodies.
	// "random" produced a uniform shuffle over the full visible set
	// above, so the first max items are a valid sample - cap immediately.
	// "name" + "recently_added" need Item.Name / DateCreated to pick
	// the right N; defer the cap to post-fetch.
	capLimit := max
	if sortMode == "name" || sortMode == "recently_added" {
		capLimit = hardMaxItems
	}
	rr := newTagRow(row, *tag, tag.Name, "", capItems(visible, capLimit))
	rr.SortMode = sortMode
	rr.MaxItems = max
	return []ResolvedRow{rr}, nil
}

func resolveTagFanout(b *browseContext, row curation.LayoutRow, cfg map[string]any) ([]ResolvedRow, error) {
	max := readMaxItems(cfg)
	include := readIntSliceConfig(cfg, "include_tag_ids")
	exclude := readIntSliceConfig(cfg, "exclude_tag_ids")
	rowOrder := readStringConfig(cfg, "row_order", "alpha")
	withinSort := readStringConfig(cfg, "within_row_sort", "name")

	all, err := b.store.ListTags(b.ctx, curation.TagSortName)
	if err != nil {
		return nil, err
	}
	excludeSet := map[int64]struct{}{}
	for _, id := range exclude {
		excludeSet[id] = struct{}{}
	}
	includeSet := map[int64]struct{}{}
	for _, id := range include {
		includeSet[id] = struct{}{}
	}
	picked := make([]curation.TagWithCount, 0, len(all))
	for _, t := range all {
		if _, ex := excludeSet[t.ID]; ex {
			continue
		}
		if len(includeSet) > 0 {
			if _, in := includeSet[t.ID]; !in {
				continue
			}
		}
		picked = append(picked, t)
	}
	if rowOrder == "random" {
		// Cache the row-order separately by row id; a second key
		// suffix lets us cache the within-row orderings under
		// different keys (we collapse by using row_id only - so
		// re-randomizing the row order also re-shuffles within-row
		// ordering, which is fine for our use case).
		picked = stableShuffleTags(b, row.ID, picked)
	}
	out := make([]ResolvedRow, 0, len(picked))
	for _, t := range picked {
		// Unlimited so per-tag random / alpha sorts cover the full pool.
		// See the matching note in resolveSingleTag.
		rawIDs, err := b.store.ListItemIDsByTag(b.ctx, t.ID, 0, 0)
		if err != nil {
			return nil, err
		}
		visible, err := b.filterVisible(rawIDs)
		if err != nil {
			return nil, err
		}
		visible = applyTagSort(b, withinSort, visible, row.ID*1000+t.ID)
		if len(visible) == 0 {
			continue
		}
		capLimit := max
		if withinSort == "name" || withinSort == "recently_added" {
			capLimit = hardMaxItems
		}
		rr := newTagRow(row, t.Tag, t.Name, fmt.Sprintf("Tag · %s", t.Name), capItems(visible, capLimit))
		rr.SortMode = withinSort
		rr.MaxItems = max
		out = append(out, rr)
	}
	return out, nil
}

func resolveRecentlyAdded(b *browseContext, row curation.LayoutRow, cfg map[string]any) ([]ResolvedRow, error) {
	max := readMaxItems(cfg)
	lookback := readIntConfig(cfg, "lookback_days", 30)
	// Overfetch a multiple of max so the visibility filter doesn't
	// starve the row + we have headroom to detect HasMore. Bumping
	// in proportion to max means load-more (which raises max) keeps
	// the same overfetch ratio.
	overfetchMul := 4
	res, err := b.jelly.GetItemsAsUser(b.ctx, jellyfin.ItemsFilter{
		IncludeItemTypes: []string{"Movie", "Series"},
		Recursive:        true,
		Limit:            max * overfetchMul,
		SortBy:           "DateCreated",
		SortOrder:        "Descending",
	}, b.userTok)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(res.Items))
	cutoff := time.Now().AddDate(0, 0, -lookback)
	for _, it := range res.Items {
		// Lookback filter when set; 0/negative = no filter.
		if lookback > 0 && it.DateCreated != "" {
			if t, err := time.Parse(time.RFC3339Nano, it.DateCreated); err == nil {
				if t.Before(cutoff) {
					continue
				}
			}
		}
		ids = append(ids, it.ID)
	}
	visible, err := b.filterVisible(ids)
	if err != nil {
		return nil, err
	}
	capped := capItems(visible, max)
	rr := newRow(row, "Recently Added", "", capped)
	// HasMore: at least one more visible item exists beyond what we
	// returned. Conservative: if Jellyfin returned the full overfetch
	// AND visibility didn't trim it below `max`, there's likely more
	// beyond our window.
	rr.HasMore = len(visible) > max
	return []ResolvedRow{rr}, nil
}

func resolveRandomUnwatched(b *browseContext, row curation.LayoutRow, cfg map[string]any) ([]ResolvedRow, error) {
	max := readMaxItems(cfg)
	// Cache stores the FULL shuffled list (not the capped slice).
	// Slicing happens at response time so load-more can grow the
	// returned slice without re-shuffling.
	var fullList []string
	if cached, _ := b.store.GetCachedRowOrder(b.ctx, b.profile.ID, b.layout.ID, row.ID, cacheTTL); cached != nil {
		_ = json.Unmarshal([]byte(cached.ItemIDsJSON), &fullList)
	}
	if fullList == nil {
		visible, err := b.store.ListEffectivelyVisibleItemIDs(b.ctx, b.profile.ID)
		if err != nil {
			return nil, err
		}
		if len(visible) == 0 {
			return []ResolvedRow{newRow(row, "Discover Something New", "", nil)}, nil
		}
		// Filter to unplayed via Jellyfin (PlayCount=0). Fetch in
		// chunks so we don't hit URL-length limits. Can't go through
		// GetItemsByIDsBatched because we need the IsUnplayed filter.
		unplayed := []string{}
		for i := 0; i < len(visible); i += jellyfin.IDBatchSize {
			end := i + jellyfin.IDBatchSize
			if end > len(visible) {
				end = len(visible)
			}
			batch := visible[i:end]
			res, err := b.jelly.GetItemsAsUser(b.ctx, jellyfin.ItemsFilter{
				IDs:     batch,
				Filters: []string{"IsUnplayed"},
			}, b.userTok)
			if err != nil {
				return nil, err
			}
			for _, it := range res.Items {
				unplayed = append(unplayed, it.ID)
			}
		}
		rand.Shuffle(len(unplayed), func(i, j int) {
			unplayed[i], unplayed[j] = unplayed[j], unplayed[i]
		})
		fullList = unplayed
		if buf, err := json.Marshal(fullList); err == nil {
			_ = b.store.SetCachedRowOrder(b.ctx, b.profile.ID, b.layout.ID, row.ID, string(buf))
		}
	}
	capped := capItems(fullList, max)
	rr := newRow(row, "Discover Something New", "", capped)
	rr.HasMore = len(fullList) > max
	return []ResolvedRow{rr}, nil
}

func resolveWatchAgain(b *browseContext, row curation.LayoutRow, cfg map[string]any) ([]ResolvedRow, error) {
	max := readMaxItems(cfg)
	dormantDays := readIntConfig(cfg, "dormant_days", 30)
	if b.userID == "" || b.userTok == "" {
		return []ResolvedRow{newRow(row, "Watch Again", "", nil)}, nil
	}
	visible, err := b.store.ListEffectivelyVisibleItemIDs(b.ctx, b.profile.ID)
	if err != nil {
		return nil, err
	}
	if len(visible) == 0 {
		return []ResolvedRow{newRow(row, "Watch Again", "", nil)}, nil
	}
	type scored struct {
		id   string
		when time.Time
	}
	out := []scored{}
	cutoff := time.Now().AddDate(0, 0, -dormantDays)
	items, err := b.jelly.GetItemsByIDsBatched(b.ctx, visible, b.userTok)
	if err != nil {
		return nil, err
	}
	for _, it := range items {
		if it.UserData == nil || it.UserData.PlayCount < 1 {
			continue
		}
		lp := it.UserData.LastPlayedDate
		if lp == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, lp)
		if err != nil {
			continue
		}
		if t.After(cutoff) {
			continue // played too recently
		}
		out = append(out, scored{id: it.ID, when: t})
	}
	// Most-recently-watched-but-still-dormant first.
	sort.Slice(out, func(i, j int) bool { return out[i].when.After(out[j].when) })
	ids := make([]string, 0, len(out))
	for _, s := range out {
		ids = append(ids, s.id)
	}
	return []ResolvedRow{newRow(row, "Watch Again", "", capItems(ids, max))}, nil
}

// --- helpers ------------------------------------------------------------

func newRow(row curation.LayoutRow, defaultTitle, subtitle string, ids []string) ResolvedRow {
	title := row.Title
	if title == "" {
		title = defaultTitle
	}
	icon := ""
	if row.Type == curation.RowFavorites {
		icon = "Heart"
	}
	return ResolvedRow{
		RowID:    row.ID,
		Type:     row.Type,
		Title:    title,
		SubTitle: subtitle,
		Icon:     icon,
		ItemIDs:  ids,
	}
}

// newTagRow is the tag / tag_fanout variant of newRow that pulls the
// tag's icon onto the resolved row when set. Falls back to bare
// newRow when icon is empty.
func newTagRow(row curation.LayoutRow, tag curation.Tag, defaultTitle, subtitle string, ids []string) ResolvedRow {
	r := newRow(row, defaultTitle, subtitle, ids)
	if tag.Icon != "" {
		r.Icon = tag.Icon
	}
	return r
}

func capItems(ids []string, max int) []string {
	if max <= 0 || len(ids) <= max {
		return ids
	}
	return ids[:max]
}

// applyTagSort orders a tag row's item ids per the sort config.
// "name" defers to Jellyfin's SortName when we batch-fetch later
// (so this returns ids unchanged); "random" shuffles using a
// stable seed per (profile, layout, key) so the shuffle is the same
// across requests inside the cache window; "recently_added" returns
// ids unchanged and the post-fetch sort handles it.
//
// Only "random" actually mutates here; the rest are sentinels for the
// caller to handle when it has full Item bodies.
func applyTagSort(b *browseContext, mode string, ids []string, key int64) []string {
	if mode != "random" {
		return ids
	}
	cached, _ := b.store.GetCachedRowOrder(b.ctx, b.profile.ID, b.layout.ID, key, cacheTTL)
	if cached != nil {
		var out []string
		if err := json.Unmarshal([]byte(cached.ItemIDsJSON), &out); err == nil {
			return out
		}
	}
	shuffled := append([]string(nil), ids...)
	rand.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
	if buf, err := json.Marshal(shuffled); err == nil {
		_ = b.store.SetCachedRowOrder(b.ctx, b.profile.ID, b.layout.ID, key, string(buf))
	}
	return shuffled
}

// stableShuffleTags picks a stable random ordering for fanout row
// keys. Mirrors applyTagSort but operates on Tag values.
func stableShuffleTags(b *browseContext, rowID int64, tags []curation.TagWithCount) []curation.TagWithCount {
	cached, _ := b.store.GetCachedRowOrder(b.ctx, b.profile.ID, b.layout.ID, -rowID, cacheTTL)
	if cached != nil {
		var ids []int64
		if err := json.Unmarshal([]byte(cached.ItemIDsJSON), &ids); err == nil {
			byID := map[int64]curation.TagWithCount{}
			for _, t := range tags {
				byID[t.ID] = t
			}
			out := make([]curation.TagWithCount, 0, len(ids))
			for _, id := range ids {
				if t, ok := byID[id]; ok {
					out = append(out, t)
				}
			}
			// Append any tags not in the cache (added since last
			// generation) so a freshly-created tag still surfaces.
			for _, t := range tags {
				found := false
				for _, id := range ids {
					if id == t.ID {
						found = true
						break
					}
				}
				if !found {
					out = append(out, t)
				}
			}
			return out
		}
	}
	out := append([]curation.TagWithCount(nil), tags...)
	rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	ids := make([]int64, len(out))
	for i, t := range out {
		ids[i] = t.ID
	}
	if buf, err := json.Marshal(ids); err == nil {
		_ = b.store.SetCachedRowOrder(b.ctx, b.profile.ID, b.layout.ID, -rowID, string(buf))
	}
	return out
}

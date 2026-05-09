package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

const (
	kidsBearerScheme   = "Bearer"
	kidsUserIDHeader   = "X-Jellyfin-User-Id"
	kidsDeviceIDHeader = "X-Jellybean-DeviceId"
)

// writeUpstreamError maps a Jellyfin error onto an HTTP status the kid
// client can react to. ErrUnauthorized propagates as 401 so the client
// auto-redirects to /login (the only sensible recovery for a stale
// kid bearer token); ErrNotFound becomes 404; everything else falls
// back to 502 so the kid sees the generic "couldn't reach server" UI.
//
// Without this, a stale Jellyfin token used to surface as 502 and the
// kid client got stuck rendering an error screen with no auto-recovery.
func writeUpstreamError(w http.ResponseWriter, err error, fallbackMsg string) {
	if errors.Is(err, jellyfin.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if jellyfin.IsUnauthorized(err) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	http.Error(w, fallbackMsg, http.StatusBadGateway)
}

// kidsRequestContext stamps the X-Jellybean-DeviceId header (when present)
// onto the request context so any downstream jellyfin call automatically
// picks it up via WithDeviceID. Use the returned context for every
// jellyfin call inside a kids handler.
func kidsRequestContext(r *http.Request) (context.Context, string) {
	deviceID := r.Header.Get(kidsDeviceIDHeader)
	return jellyfin.WithDeviceID(r.Context(), deviceID), deviceID
}

// kidsContext describes who is hitting a /api/kids/* endpoint and which
// Jellyfin user their requests should be attributed to.
type kidsContext struct {
	JellyfinUserID string
	JellyfinToken  string // bearer token from the TV; empty on admin path
	ProfileID      int64
	KidID          int64  // jellybean kid row id; 0 on admin path
	Source         string // "admin" or "kid"
	Label          string
}

// resolveKidsAuth accepts either an admin session cookie (parent testing
// the kids client from the same browser) OR an Authorization: Bearer
// <token> + X-Jellyfin-User-Id header pair from a kid client that has
// already gone through /api/kids/auth/login.
//
// The bearer token is what Jellyfin's AuthenticateByName returned; we
// trust it for downstream Jellyfin calls. The user id is used to look
// up which profile the kid record maps to.
func (s *Server) resolveKidsAuth(r *http.Request) *kidsContext {
	if sess := auth.SessionFromContext(r.Context()); sess != nil {
		return &kidsContext{
			JellyfinUserID: sess.UserID,
			Source:         "admin",
			Label:          sess.UserName,
		}
	}
	token, userID, ok := parseBearer(r)
	if !ok {
		return nil
	}
	kid, err := s.curation.FindKidByJellyfinUser(r.Context(), userID)
	if err != nil {
		if !errors.Is(err, curation.ErrKidNotFound) {
			s.logger.Error().Err(err).Msg("kid lookup")
		}
		return nil
	}
	return &kidsContext{
		JellyfinUserID: kid.JellyfinUserID,
		JellyfinToken:  token,
		ProfileID:      kid.ProfileID,
		KidID:          kid.ID,
		Source:         "kid",
		Label:          kid.Name,
	}
}

// parseBearer extracts the Jellyfin access token + user id from the
// request. Primary path: Authorization: Bearer <token> + X-Jellyfin-User-Id
// header. Fallback: ?token=<>&userId=<> query params. The fallback exists
// because <img> elements (and <video src=...>) can't attach custom headers
// in WebView, so sub-resources need a header-free auth channel.
func parseBearer(r *http.Request) (token, userID string, ok bool) {
	if h := r.Header.Get("Authorization"); h != "" {
		parts := strings.SplitN(h, " ", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], kidsBearerScheme) {
			tok := strings.TrimSpace(parts[1])
			uid := strings.TrimSpace(r.Header.Get(kidsUserIDHeader))
			if tok != "" && uid != "" {
				return tok, uid, true
			}
		}
	}
	// Query-string fallback for sub-resources that can't set headers.
	q := r.URL.Query()
	tok := strings.TrimSpace(q.Get("token"))
	uid := strings.TrimSpace(q.Get("userId"))
	if tok != "" && uid != "" {
		return tok, uid, true
	}
	return "", "", false
}

// resolveKidsProfileID returns the profile id this caller is acting under.
// For kid bearer auth the profile is implicit (kid record carries it);
// for admin auth it must be supplied via ?profileId=. Returns 0 + a 4xx
// error message when ambiguous.
func (s *Server) resolveKidsProfileID(r *http.Request, kc *kidsContext) (int64, string) {
	if kc.ProfileID > 0 {
		return kc.ProfileID, ""
	}
	if v := r.URL.Query().Get("profileId"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			return 0, "profileId must be a positive integer"
		}
		return n, ""
	}
	return 0, "profileId query param required (admin path)"
}

// handleKidsLogin is the kids client's normal-app login. The TV / mobile
// app POSTs Jellyfin credentials here; we forward to Jellyfin's
// AuthenticateByName, look up the kid record by the resolved user id,
// and return the bearer token plus the profile mapping the client
// should scope itself to.
//
// 401 = bad Jellyfin credentials. 403 = valid Jellyfin user but not
// mapped to a kid in Jellybean. 502 = Jellyfin is unreachable.
func (s *Server) handleKidsLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Username == "" || req.Password == "" {
		http.Error(w, "username and password required", http.StatusBadRequest)
		return
	}

	ctx, _ := kidsRequestContext(r)
	res, err := s.jellyfin.AuthenticateByName(ctx, req.Username, req.Password)
	if err != nil {
		if jellyfin.IsUnauthorized(err) {
			http.Error(w, "wrong username or password", http.StatusUnauthorized)
			return
		}
		s.logger.Error().Err(err).Msg("kids login: jellyfin auth")
		http.Error(w, "Jellyfin auth backend error", http.StatusBadGateway)
		return
	}
	kid, err := s.curation.FindKidByJellyfinUser(r.Context(), res.User.ID)
	if err != nil {
		if errors.Is(err, curation.ErrKidNotFound) {
			http.Error(w,
				"this Jellyfin user is not configured as a kid in Jellybean",
				http.StatusForbidden)
			return
		}
		s.logger.Error().Err(err).Msg("kids login: kid lookup")
		http.Error(w, "lookup failed", http.StatusInternalServerError)
		return
	}

	s.logger.Info().
		Str("kid", kid.Name).
		Str("jellyfin_user_id", kid.JellyfinUserID).
		Int64("profile_id", kid.ProfileID).
		Msg("kid login")

	writeJSON(w, http.StatusOK, map[string]any{
		"token":       res.AccessToken,
		"userId":      res.User.ID,
		"userName":    res.User.Name,
		"kidId":       kid.ID,
		"kidName":     kid.Name,
		"profileId":   kid.ProfileID,
		"profileName": kid.ProfileName,
	})
}

// handleKidsLibrary returns the library view for the active kid: visible
// items only, optionally filtered by type, with sub-views for "all",
// "continue-watching", and "recent".
func (s *Server) handleKidsLibrary(w http.ResponseWriter, r *http.Request) {
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

	q := r.URL.Query()
	section := q.Get("section")
	if section == "" {
		section = "all"
	}
	switch section {
	case "all", "continue-watching", "recent":
		// ok
	default:
		http.Error(w, "section must be all, continue-watching, or recent", http.StatusBadRequest)
		return
	}

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
	allowedTypes := map[string]struct{}{}
	for _, t := range itemTypes {
		allowedTypes[t] = struct{}{}
	}

	limit := 50
	if v := q.Get("limit"); v != "" {
		// Cap at 5000 to match the kid client's PAGE_SIZE - the
		// alpha picker needs the full library loaded so it can jump
		// to any letter, not just letters within the first paginated
		// page. Slim payload keeps the wire weight bounded even at
		// the cap (~300KB for 5000 items before gzip).
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 5000 {
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

	// sort selects the ordering used by the "all" section. "name"
	// keeps the existing alpha + paginated flow; the recency sorts
	// fetch the entire visible set in one pass and order it
	// server-side so the kid client can render time-bucketed
	// sections without juggling pagination across buckets.
	sortParam := strings.ToLower(strings.TrimSpace(q.Get("sort")))
	switch sortParam {
	case "", "name":
		sortParam = "name"
	case "recently_added", "recently_watched":
		// ok
	default:
		http.Error(w, "sort must be name, recently_added, or recently_watched", http.StatusBadRequest)
		return
	}

	ctx, _ := kidsRequestContext(r)

	// Build the ETag from DB-only state (no Jellyfin round-trip yet) so a
	// matching If-None-Match can short-circuit to 304 without leaving the
	// database. The composition has to cover everything that affects the
	// response shape: profile id, paging + filter params, the profile's
	// max(set_at) (so a parent flipping visibility invalidates), and for
	// continue-watching the kid's user id plus a coarse time bucket.
	maxSetAt, err := s.curation.ProfileMaxSetAt(ctx, profileID)
	if err != nil {
		s.logger.Error().Err(err).Msg("kids library etag")
		http.Error(w, "failed to load library", http.StatusInternalServerError)
		return
	}
	etag := computeKidsLibraryETag(kidsLibraryETagInputs{
		ProfileID:      profileID,
		Section:        section,
		Types:          itemTypes,
		Limit:          limit,
		StartIndex:     startIndex,
		Search:         search,
		Sort:           sortParam,
		MaxSetAt:       maxSetAt,
		JellyfinUserID: kc.JellyfinUserID,
	})
	if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
		w.Header().Set("ETag", etag)
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("ETag", etag)

	if section == "continue-watching" {
		if kc.JellyfinUserID == "" || kc.JellyfinToken == "" {
			writeJSON(w, http.StatusOK, kidsLibraryResponse{ProfileID: profileID})
			return
		}
		res, err := s.jellyfin.GetResumeItems(ctx, kc.JellyfinUserID, kc.JellyfinToken, limit*2)
		if err != nil {
			s.logger.Error().Err(err).Msg("kids resume")
			writeUpstreamError(w, err, "failed to load continue watching")
			return
		}
		// Episode→series rewrite (see resumeIDsForCuration in
		// browse_resolver.go for rationale): episodes have no
		// per-episode curation state; we surface their parent series
		// instead so categorization filters work and the kid sees
		// one tile per show.
		ids := resumeIDsForCuration(res.Items)
		visible, err := s.curation.EffectiveItemVisibilityBulk(ctx, profileID, ids)
		if err != nil {
			s.logger.Error().Err(err).Msg("resume visibility lookup")
			http.Error(w, "failed to load visibility", http.StatusInternalServerError)
			return
		}
		// Re-fetch the rewritten ids as actual items so the slim
		// browseItem we render carries series posters and series-level
		// UserData (Jellyfin aggregates child progress to the series).
		// We do this in one batch via GetItemsByIDs to avoid N+1.
		visibleIDs := make([]string, 0, len(ids))
		for _, id := range ids {
			if visible[id] == curation.StateVisible {
				visibleIDs = append(visibleIDs, id)
			}
			if len(visibleIDs) >= limit {
				break
			}
		}
		// Re-resolve the (possibly rewritten) ids as full Items via
		// the kid's user token so each tile carries series-level
		// poster + UserData (Jellyfin aggregates child progress to
		// the series).
		byID := make(map[string]jellyfin.Item, len(visibleIDs))
		if len(visibleIDs) > 0 {
			const batch = 100
			for i := 0; i < len(visibleIDs); i += batch {
				end := i + batch
				if end > len(visibleIDs) {
					end = len(visibleIDs)
				}
				resItems, err := s.jellyfin.GetItemsAsUser(
					ctx,
					jellyfin.ItemsFilter{IDs: visibleIDs[i:end]},
					kc.JellyfinToken,
				)
				if err != nil {
					s.logger.Error().Err(err).Msg("resume series fetch")
					writeUpstreamError(w, err, "failed to load continue watching")
					return
				}
				for _, it := range resItems.Items {
					byID[it.ID] = it
				}
			}
		}
		out := make([]browseItem, 0, len(visibleIDs))
		for _, id := range visibleIDs {
			it, ok := byID[id]
			if !ok {
				continue
			}
			if _, allowed := allowedTypes[it.Type]; !allowed {
				continue
			}
			out = append(out, toBrowseItem(it))
		}
		writeJSON(w, http.StatusOK, kidsLibraryResponse{Items: out, ProfileID: profileID})
		return
	}

	// ListEffectivelyVisibleItemIDs honors profile_tag_filters - items
	// can become visible via an always_visible filter even without an
	// explicit visible categorization, and visible-categorized items
	// can be hidden by an always_hidden filter on any of their tags.
	ids, err := s.curation.ListEffectivelyVisibleItemIDs(ctx, profileID)
	if err != nil {
		s.logger.Error().Err(err).Msg("list visible ids")
		http.Error(w, "failed to load library", http.StatusInternalServerError)
		return
	}
	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, kidsLibraryResponse{ProfileID: profileID})
		return
	}

	// Effective sort + Jellyfin SortBy choice. The "recent" section
	// keeps its DateCreated default; the new ?sort= param on the
	// "all" section drives an alternate order. Recency sorts use
	// the entire visible set in one pass (no pagination) so the
	// client can render time-bucketed sections without juggling
	// page boundaries.
	effectiveSort := sortParam
	if section == "recent" {
		effectiveSort = "recently_added"
	}
	sortBy := "SortName"
	sortOrder := "Ascending"
	switch effectiveSort {
	case "recently_added":
		sortBy = "DateCreated"
		sortOrder = "Descending"
	case "recently_watched":
		// LastPlayedDate isn't a Jellyfin SortBy field; we sort
		// client-side after the merge. Pull in alpha order so the
		// "never watched" tail stays alphabetical without a
		// secondary sort.
		sortBy = "SortName"
		sortOrder = "Ascending"
	}
	bypassPaging := effectiveSort == "recently_added" || effectiveSort == "recently_watched"

	// Batch the IDs filter so we don't blow Jellyfin's URI length
	// limit. A profile with hundreds of visible items (Nottingham has
	// ~436) would otherwise produce a single >8KB query string and
	// trip Jellyfin's 414 URI Too Long. Each chunk is a real Jellyfin
	// query (so per-user UserData + search-term filter still apply);
	// we re-sort after the merge because Jellyfin's order is only
	// valid within a batch.
	merged := make([]jellyfin.Item, 0, len(ids))
	for i := 0; i < len(ids); i += jellyfinIDBatchSize {
		end := i + jellyfinIDBatchSize
		if end > len(ids) {
			end = len(ids)
		}
		batch := ids[i:end]
		res, err := s.jellyfin.GetItemsAsUser(ctx, jellyfin.ItemsFilter{
			IDs:        batch,
			SortBy:     sortBy,
			SortOrder:  sortOrder,
			SearchTerm: search,
		}, kc.JellyfinToken)
		if err != nil {
			s.logger.Error().Err(err).Msg("kids library fetch")
			writeUpstreamError(w, err, "failed to load library")
			return
		}
		merged = append(merged, res.Items...)
	}

	// Re-sort across batches. Jellyfin's per-batch order is valid
	// only within each chunk; "A" from chunk 2 and "B" from chunk 1
	// would otherwise come back as B,A.
	switch effectiveSort {
	case "recently_added":
		sort.SliceStable(merged, func(i, j int) bool {
			return merged[i].DateCreated > merged[j].DateCreated
		})
	case "recently_watched":
		// Watched items first (LastPlayedDate desc); unwatched
		// trailing alphabetically. Empty LastPlayedDate counts as
		// "never watched" and gets bucketed by the kid client into
		// the "Never watched" section.
		sort.SliceStable(merged, func(i, j int) bool {
			pi := lastPlayed(merged[i])
			pj := lastPlayed(merged[j])
			if (pi == "") != (pj == "") {
				return pi != ""
			}
			if pi != pj {
				return pi > pj
			}
			return strings.ToLower(merged[i].Name) < strings.ToLower(merged[j].Name)
		})
	default:
		sort.SliceStable(merged, func(i, j int) bool {
			return strings.ToLower(merged[i].Name) < strings.ToLower(merged[j].Name)
		})
	}

	filtered := make([]jellyfin.Item, 0, len(merged))
	for _, it := range merged {
		if _, ok := allowedTypes[it.Type]; ok {
			filtered = append(filtered, it)
		}
	}

	// LettersByName is only useful for the alpha sort. Skip the
	// computation on recency sorts - the kid client hides the A-Z
	// jump button there anyway.
	var letters map[string]int
	if effectiveSort == "name" {
		letters = computeLettersByName(filtered)
	}

	totalAvailable := len(ids)
	var (
		hasMore bool
		page    []jellyfin.Item
	)
	if bypassPaging {
		page = filtered
	} else {
		end := startIndex + limit
		hasMore = end < len(filtered)
		if startIndex > len(filtered) {
			page = nil
		} else {
			if end > len(filtered) {
				end = len(filtered)
			}
			page = filtered[startIndex:end]
		}
	}

	slim := make([]browseItem, len(page))
	for i, it := range page {
		slim[i] = toBrowseItem(it)
	}

	resp := kidsLibraryResponse{
		Items:          slim,
		TotalAvailable: totalAvailable,
		StartIndex:     startIndex,
		NextStartIndex: startIndex + len(slim),
		HasMore:        hasMore,
		ProfileID:      profileID,
		LettersByName:  letters,
	}
	writeJSON(w, http.StatusOK, resp)
}

type kidsLibraryResponse struct {
	Items          []browseItem `json:"Items"`
	TotalAvailable int          `json:"TotalAvailable,omitempty"`
	StartIndex     int          `json:"StartIndex"`
	NextStartIndex int          `json:"NextStartIndex,omitempty"`
	HasMore        bool         `json:"HasMore,omitempty"`
	ProfileID      int64        `json:"ProfileId"`
	// LettersByName maps each starting letter (A-Z plus "#") to the
	// index in the full sorted library where the first item with that
	// letter lives. Computed BEFORE pagination so the kid client's
	// alpha picker can jump anywhere in the library, not just into
	// the first loaded page. "#" is the bucket for items whose first
	// character isn't A-Z (numerics, punctuation, etc.). Returned
	// only on the "all" section since cw / recent are short rows.
	LettersByName map[string]int `json:"LettersByName,omitempty"`
}

// computeLettersByName scans the full sorted library and returns the
// "first item that starts with X" index for each starting letter.
// Mirrors the kid client's old client-side firstIndexByLetter so the
// two stay aligned: case-insensitive, strips a leading "the "/"a "/
// "an " article. Items whose first character isn't A-Z bucket into
// "#".
func computeLettersByName(items []jellyfin.Item) map[string]int {
	out := map[string]int{}
	for i, it := range items {
		raw := strings.TrimSpace(it.Name)
		// Article-strip mirror of AlphaBar.tsx's firstIndexByLetter.
		lower := strings.ToLower(raw)
		switch {
		case strings.HasPrefix(lower, "the "):
			raw = raw[4:]
		case strings.HasPrefix(lower, "an "):
			raw = raw[3:]
		case strings.HasPrefix(lower, "a "):
			raw = raw[2:]
		}
		if raw == "" {
			continue
		}
		ch := strings.ToUpper(raw[:1])
		key := "#"
		if ch >= "A" && ch <= "Z" {
			key = ch
		}
		if _, exists := out[key]; !exists {
			out[key] = i
		}
	}
	return out
}

// kidsLibraryETagInputs is the set of values that feed the GET
// /api/kids/library ETag. Anything that affects the response shape goes
// here; anything that doesn't (e.g. Jellyfin item fields) does not. The
// goal is to compute the ETag from DB-only state so a matching
// If-None-Match can short-circuit to 304 without a Jellyfin round-trip.
type kidsLibraryETagInputs struct {
	ProfileID      int64
	Section        string
	Types          []string
	Limit          int
	StartIndex     int
	Search         string
	Sort           string
	MaxSetAt       int64
	JellyfinUserID string
}

// computeKidsLibraryETag returns a weak ETag (W/"...") for the given
// inputs.
//
// JellyfinUserID is mixed in for every section, not just
// continue-watching: GetItemsAsUser asks Jellyfin for per-user UserData
// (resume position, watched flag, play count) on the "all" + "recent"
// sections too. Two kids on the same Jellybean profile have different
// UserData, so the response body differs even when the curation state
// is identical. Without userId in the ETag, a shared cache could
// (today) or will (when the client renders watched markers) hand
// kid B's body to kid A.
//
// For section=continue-watching we additionally mix in a per-minute
// time bucket so the resume row refreshes at most once a minute on
// inactive devices but invalidates promptly when the kid plays. This
// is intentional: resume ticks live in Jellyfin and we have no cheap
// server-side signal for "did playback happen since last request", so
// a coarse clock bucket is the cheapest correct invalidator. Don't
// remove the bucket - stale resume rows are a worse failure mode than
// an extra round-trip per minute.
func computeKidsLibraryETag(in kidsLibraryETagInputs) string {
	types := append([]string(nil), in.Types...)
	sort.Strings(types)

	var b strings.Builder
	fmt.Fprintf(&b, "profile=%d;sec=%s;type=%s;limit=%d;start=%d;search=%s;sort=%s;mtime=%d;userId=%s",
		in.ProfileID,
		in.Section,
		strings.Join(types, ","),
		in.Limit,
		in.StartIndex,
		in.Search,
		in.Sort,
		in.MaxSetAt,
		in.JellyfinUserID,
	)
	if in.Section == "continue-watching" {
		fmt.Fprintf(&b, ";tbucket=%d", time.Now().Unix()/60)
	}

	sum := sha256.Sum256([]byte(b.String()))
	return `W/"` + base64.RawURLEncoding.EncodeToString(sum[:]) + `"`
}

func itemIDs(items []jellyfin.Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}

type playbackPayload struct {
	ItemID           string `json:"itemId"`
	SeriesID         string `json:"seriesId,omitempty"`
	MediaSourceID    string `json:"mediaSourceId,omitempty"`
	PlaySessionID    string `json:"playSessionId,omitempty"`
	PositionTicks    int64  `json:"positionTicks"`
	IsPaused         bool   `json:"isPaused,omitempty"`
	AudioStreamIndex int    `json:"audioStreamIndex,omitempty"`
}

func decodePlaybackPayload(r *http.Request) (*playbackPayload, error) {
	var p playbackPayload
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		return nil, err
	}
	if p.ItemID == "" {
		return nil, errors.New("itemId required")
	}
	return &p, nil
}

func (s *Server) handleKidsPlaybackStart(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	p, err := decodePlaybackPayload(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ctx, _ := kidsRequestContext(r)
	err = s.jellyfin.ReportPlaybackStart(ctx, kc.JellyfinToken, jellyfin.PlaybackStartInfo{
		ItemID:           p.ItemID,
		MediaSourceID:    p.MediaSourceID,
		PlaySessionID:    p.PlaySessionID,
		PositionTicks:    p.PositionTicks,
		IsPaused:         p.IsPaused,
		CanSeek:          true,
		AudioStreamIndex: p.AudioStreamIndex,
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("kid", kc.Label).Str("item", p.ItemID).Msg("playback start report")
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleKidsPlaybackProgress(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	p, err := decodePlaybackPayload(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ctx, _ := kidsRequestContext(r)
	err = s.jellyfin.ReportPlaybackProgress(ctx, kc.JellyfinToken, jellyfin.PlaybackProgressInfo{
		ItemID:           p.ItemID,
		MediaSourceID:    p.MediaSourceID,
		PlaySessionID:    p.PlaySessionID,
		PositionTicks:    p.PositionTicks,
		IsPaused:         p.IsPaused,
		AudioStreamIndex: p.AudioStreamIndex,
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("kid", kc.Label).Str("item", p.ItemID).Msg("playback progress report")
	}
	// M10: side-effect to maintain kid_watch_segments. Only kid path
	// (admin preview has no kid id and no time tracking).
	if kc.KidID > 0 {
		now := time.Now().UTC()
		if rerr := s.curation.RecordPlaybackProgress(ctx, kc.KidID, kc.ProfileID, p.ItemID, p.SeriesID, p.IsPaused, now); rerr != nil {
			s.logger.Warn().Err(rerr).Int64("kid", kc.KidID).Str("item", p.ItemID).Msg("watch segment record")
		}
		if berr := s.curation.RecordPlayActivity(ctx, kc.KidID, p.ItemID, p.SeriesID, p.IsPaused, now); berr != nil {
			s.logger.Warn().Err(berr).Int64("kid", kc.KidID).Msg("body-break activity record")
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleKidsPlaybackStopped(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	p, err := decodePlaybackPayload(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ctx, _ := kidsRequestContext(r)
	err = s.jellyfin.ReportPlaybackStopped(ctx, kc.JellyfinToken, jellyfin.PlaybackStopInfo{
		ItemID:        p.ItemID,
		MediaSourceID: p.MediaSourceID,
		PlaySessionID: p.PlaySessionID,
		PositionTicks: p.PositionTicks,
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("kid", kc.Label).Str("item", p.ItemID).Msg("playback stopped report")
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleKidsStopEncoding releases the Jellyfin transcode session
// identified by playSessionId. The kid client calls this before
// switching to a new stream URL within the same Play instance
// (e.g. Next-episode) so Jellyfin doesn't accumulate stale ffmpeg
// processes. Mirrors jellyfin-web's apiClient.stopActiveEncodings.
//
// Body: {"playSessionId": "..."}. Empty / missing playSessionId is a
// no-op (returns 204) so the client can call it unconditionally on
// stream-swap without checking whether a previous session existed.
func (s *Server) handleKidsStopEncoding(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	var req struct {
		PlaySessionID string `json:"playSessionId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ctx, _ := kidsRequestContext(r)
	if err := s.jellyfin.StopActiveEncodings(ctx, kc.JellyfinToken, req.PlaySessionID); err != nil {
		// Best-effort: a stale session ID typically returns 404 from
		// Jellyfin which we've already mapped to ErrNotFound. Log but
		// don't fail the kid client - the new stream load will still
		// proceed.
		s.logger.Warn().
			Err(err).
			Str("kid", kc.Label).
			Str("play_session_id", req.PlaySessionID).
			Msg("stop active encodings")
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleKidsRefreshLayout drops the kid's profile-scoped layout row
// cache so the next /api/kids/browse re-resolves every randomized
// row from scratch (random_unwatched shuffle, tag_fanout ordering).
// Backed by the Menu modal's "Refresh from server" action - a TV
// remote one-click way to force-pull fresh layout state without
// leaving the kid app.
//
// Layout STRUCTURE changes (rows added/removed/edited) auto-bust
// this cache via curation/layouts.go's row mutators. This endpoint
// is for content changes the row mutators can't observe - tag
// membership, item visibility, etc. - that the kid wants to see
// reflected before the 60-min TTL expires.
func (s *Server) handleKidsRefreshLayout(w http.ResponseWriter, r *http.Request) {
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
	if err := s.curation.InvalidateProfileLayoutCache(r.Context(), profileID); err != nil {
		s.logger.Error().Err(err).Int64("profile_id", profileID).Msg("kids refresh layout cache")
		http.Error(w, "failed to refresh", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// conservativeDeviceProfile is the lowest-common-denominator Jellyfin
// DeviceProfile we hand to PostPlaybackInfo for every kids stream
// request. It direct-plays only the narrowest set of codecs (h264 +
// AAC stereo) and forces transcode for everything else. The hard cap
// at 5 Mbps is the safe ceiling for cheap consumer Android TV WebViews
// (the Skyworth M5 testing case).
//
// The player rebuild dropped the client-driven `?maxBitrate=N` ladder
// in favor of trusting this single profile cap; the kid client lets
// hls.js's recovery ladder + the JS->Kotlin Reset Player bridge handle
// the rare cases where a stream is genuinely unplayable on the device.
const conservativeDeviceProfile = `{
    "Name": "Conservative",
    "MaxStreamingBitrate": 5000000,
    "MaxStaticBitrate": 5000000,
    "MusicStreamingTranscodingBitrate": 192000,
    "DirectPlayProfiles": [
        {"Type": "Video", "Container": "mp4", "VideoCodec": "h264", "AudioCodec": "aac"}
    ],
    "TranscodingProfiles": [
        {
            "Type": "Video",
            "Container": "ts",
            "Protocol": "hls",
            "VideoCodec": "h264",
            "AudioCodec": "aac",
            "Context": "Streaming",
            "MaxAudioChannels": "2",
            "MinSegments": 1,
            "BreakOnNonKeyFrames": true
        },
        {"Type": "Audio", "Container": "mp3", "AudioCodec": "mp3", "Context": "Streaming"}
    ],
    "ContainerProfiles": [],
    "CodecProfiles": [
        {
            "Type": "Video",
            "Codec": "h264",
            "Conditions": [
                {"Condition": "EqualsAny", "Property": "VideoProfile", "Value": "baseline|main|high", "IsRequired": false},
                {"Condition": "LessThanEqual", "Property": "VideoLevel", "Value": "41", "IsRequired": false},
                {"Condition": "LessThanEqual", "Property": "Width", "Value": "1920", "IsRequired": false},
                {"Condition": "LessThanEqual", "Property": "Height", "Value": "1080", "IsRequired": false}
            ]
        }
    ],
    "SubtitleProfiles": [
        {"Format": "vtt", "Method": "External"}
    ]
}`

const conservativeProfileMaxBitrate int64 = 5_000_000

// handleKidsStream returns a per-device-negotiated stream URL for the
// requested item. Auth: admin session cookie or kid bearer token.
//
// Flow:
//  1. POST PlaybackInfo to Jellyfin with the Conservative DeviceProfile
//     so source selection (DirectPlay / DirectStream / Transcode) is
//     informed by what a typical kid TV can actually render.
//  2. Pass StartTimeTicks from the item's UserData so Jellyfin's
//     transcode session starts at the resume position - matches
//     jellyfin-web's playbackmanager pattern.
//  3. Return the negotiated URL plus item metadata to the kid client.
//
// The client extracts the PlaySessionId from the returned StreamURL
// itself (Jellyfin embeds it as a query param) and threads it back on
// playback reports - mirrors jellyfin-web's getParam() pattern.
func (s *Server) handleKidsStream(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}

	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}

	ctx, deviceID := kidsRequestContext(r)
	var (
		item *jellyfin.Item
		err  error
	)
	if kc.JellyfinToken != "" {
		res, ferr := s.jellyfin.GetItemsAsUser(ctx, jellyfin.ItemsFilter{IDs: []string{id}}, kc.JellyfinToken)
		if ferr == nil && len(res.Items) == 0 {
			err = jellyfin.ErrNotFound
		} else if ferr == nil {
			item = &res.Items[0]
		} else {
			err = ferr
		}
	} else {
		item, err = s.jellyfin.GetItem(ctx, id)
	}
	if err != nil {
		s.logger.Error().Err(err).Str("id", id).Msg("kids stream resolve")
		writeUpstreamError(w, err, "failed to resolve item")
		return
	}

	// Series have no MediaSource of their own - PostPlaybackInfo would
	// 500. The kid client special-cases itemType=Series anyway: it
	// follows up with /next-up to get an episode id and re-calls
	// /stream on that. Return metadata only and skip the negotiation.
	if item.Type == "Series" {
		writeJSON(w, http.StatusOK, kidsStreamResponse{
			ItemID:         id,
			ItemName:       item.Name,
			ItemType:       item.Type,
			ProductionYear: item.ProductionYear,
		})
		return
	}

	audioIdx := s.kidsPreferredAudioStreamIndex(ctx, item, kc, r)

	// Resume from the user's last position. We hand StartTimeTicks to
	// Jellyfin in the PlaybackInfo body so the transcode session
	// produces segments at the resume point instead of t=0; the client
	// also gets hls.js's startPosition set so the player seeks to the
	// same offset client-side. This is what jellyfin-web does.
	var startTimeTicks int64
	if item.UserData != nil {
		startTimeTicks = item.UserData.PlaybackPositionTicks
	}

	resolution, err := s.jellyfin.PostPlaybackInfo(
		ctx,
		id,
		kc.JellyfinUserID,
		kc.JellyfinToken,
		json.RawMessage(conservativeDeviceProfile),
		conservativeProfileMaxBitrate,
		audioIdx,
		startTimeTicks,
	)
	if err != nil {
		if errors.Is(err, jellyfin.ErrNotFound) {
			http.Error(w, "no playable source for this device", http.StatusUnprocessableEntity)
			return
		}
		s.logger.Error().Err(err).Str("id", id).Msg("kids stream playback info")
		writeUpstreamError(w, err, "failed to negotiate playback")
		return
	}

	s.logger.Info().
		Str("auth_source", kc.Source).
		Str("auth_label", kc.Label).
		Str("jellyfin_user_id", kc.JellyfinUserID).
		Bool("user_token_used", kc.JellyfinToken != "").
		Str("item_id", id).
		Str("item_name", item.Name).
		Str("device_id", deviceID).
		Str("playback_path", string(resolution.Path)).
		Str("media_source_id", resolution.MediaSourceID).
		Str("play_session_id", resolution.PlaySessionID).
		Int64("start_time_ticks", startTimeTicks).
		Int("audio_stream_index", audioIdx).
		Msg("kids stream resolved")

	resp := kidsStreamResponse{
		StreamURL:           resolution.StreamURL,
		ItemID:              id,
		ItemName:            item.Name,
		ItemType:            item.Type,
		SeriesID:            item.SeriesID,
		SeriesName:          item.SeriesName,
		ParentIndexNumber:   item.ParentIndexNumber,
		IndexNumber:    item.IndexNumber,
		ProductionYear: item.ProductionYear,
		RunTimeTicks:   item.RunTimeTicks,
		MediaSourceID:  resolution.MediaSourceID,
		PlaybackPath:   string(resolution.Path),
	}
	if item.UserData != nil {
		resp.UserData = item.UserData
	}
	// Favorite target: series for episodes, item itself otherwise.
	// Browse rows surface series, not episodes, so favoriting an
	// episode would create an entry that never appears in any row.
	favTarget := id
	if item.Type == "Episode" && item.SeriesID != "" {
		favTarget = item.SeriesID
	}
	resp.FavoriteItemID = favTarget
	if kc.KidID > 0 {
		if fav, ferr := s.curation.IsKidFavorite(r.Context(), kc.KidID, favTarget); ferr == nil {
			resp.IsFavorite = fav
		}
	}
	writeJSON(w, http.StatusOK, resp)
}


// kidsItemResponse is the lightweight metadata payload for the M7
// watch menu. Distinct from kidsStreamResponse: this endpoint does NOT
// hit PostPlaybackInfo, so opening the watch menu doesn't kick off a
// transcode session for content the kid hasn't decided to play yet.
type kidsItemResponse struct {
	ItemID         string                 `json:"itemId"`
	ItemName       string                 `json:"itemName"`
	ItemType       string                 `json:"itemType,omitempty"`
	SeriesID       string                 `json:"seriesId,omitempty"`
	SeriesName     string                 `json:"seriesName,omitempty"`
	ProductionYear int                    `json:"productionYear,omitempty"`
	RunTimeTicks   int64                  `json:"runtimeTicks,omitempty"`
	UserData       *jellyfin.ItemUserData `json:"userData,omitempty"`
	// IsFavorite is the kid's per-(kid, item) favorite flag from
	// SQLite. The watch menu reads it to render the heart icon's
	// initial state. Always present on the kid-auth path; false on
	// admin preview (no kid context).
	IsFavorite bool `json:"isFavorite"`
}

// handleKidsItem returns just the metadata for a single item -
// driven by the M7 watch menu, which needs name + UserData to render
// hero buttons (Play / Resume / Restart / Watch Again) without
// triggering a transcode session.
func (s *Server) handleKidsItem(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	ctx, _ := kidsRequestContext(r)
	var (
		item *jellyfin.Item
		err  error
	)
	if kc.JellyfinToken != "" {
		res, ferr := s.jellyfin.GetItemsAsUser(ctx, jellyfin.ItemsFilter{IDs: []string{id}}, kc.JellyfinToken)
		if ferr == nil && len(res.Items) == 0 {
			err = jellyfin.ErrNotFound
		} else if ferr == nil {
			item = &res.Items[0]
		} else {
			err = ferr
		}
	} else {
		item, err = s.jellyfin.GetItem(ctx, id)
	}
	if err != nil {
		s.logger.Error().Err(err).Str("id", id).Msg("kids item resolve")
		writeUpstreamError(w, err, "failed to resolve item")
		return
	}
	resp := kidsItemResponse{
		ItemID:         id,
		ItemName:       item.Name,
		ItemType:       item.Type,
		SeriesID:       item.SeriesID,
		SeriesName:     item.SeriesName,
		ProductionYear: item.ProductionYear,
		RunTimeTicks:   item.RunTimeTicks,
		UserData:       item.UserData,
	}
	if kc.KidID > 0 {
		if fav, ferr := s.curation.IsKidFavorite(r.Context(), kc.KidID, id); ferr == nil {
			resp.IsFavorite = fav
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleKidsItemFavorite toggles the per-kid favorite flag for one
// item. Kid-auth required (no PIN gate); the heart icon on the watch
// menu lets the kid manage their own favorites directly. Admin
// preview (no KidID) returns 403 - admins manage favorites via the
// admin UI, not this endpoint.
//
// Body: {"state":"add"} | {"state":"remove"}. Idempotent on both.
func (s *Server) handleKidsItemFavorite(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	if kc.KidID == 0 {
		http.Error(w, "favorites are per-kid; admin preview can't toggle", http.StatusForbidden)
		return
	}
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	var req struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	switch req.State {
	case "add":
		if err := s.curation.AddKidFavorite(r.Context(), kc.KidID, id); err != nil {
			s.logger.Error().Err(err).Int64("kid", kc.KidID).Str("item", id).Msg("kid favorite add")
			http.Error(w, "failed to add favorite", http.StatusInternalServerError)
			return
		}
	case "remove":
		if err := s.curation.RemoveKidFavorite(r.Context(), kc.KidID, id); err != nil {
			s.logger.Error().Err(err).Int64("kid", kc.KidID).Str("item", id).Msg("kid favorite remove")
			http.Error(w, "failed to remove favorite", http.StatusInternalServerError)
			return
		}
	default:
		http.Error(w, `state must be "add" or "remove"`, http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleKidsSeriesEpisodes returns the full season + episode list for
// a series, with per-episode UserData (resume position, watched flag,
// played percentage) so the M7 watch menu's accordion can render
// progress markers without a second round trip.
//
// Episodes are grouped by season number ascending; specials (season
// 0) sort to the top per Jellyfin convention.
func (s *Server) handleKidsSeriesEpisodes(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "series id required", http.StatusBadRequest)
		return
	}
	ctx, _ := kidsRequestContext(r)

	// Per-user fetch (kid path) brings UserData through; admin preview
	// has no kid token, so the accordion renders structure-only with
	// no progress markers. Both paths use the same items filter; only
	// the auth differs.
	useUser := kc.JellyfinToken != ""
	fetch := func(f jellyfin.ItemsFilter) (*jellyfin.ItemsResult, error) {
		if useUser {
			return s.jellyfin.GetItemsAsUser(ctx, f, kc.JellyfinToken)
		}
		return s.jellyfin.GetItems(ctx, f)
	}

	// Resolve the series first so we can return the name + verify it's
	// actually a Series (defensive against a kid hitting this with a
	// movie id, which would 500 the items query otherwise).
	res, err := fetch(jellyfin.ItemsFilter{IDs: []string{id}})
	if err != nil {
		s.logger.Error().Err(err).Msg("episodes: series lookup")
		writeUpstreamError(w, err, "failed to load series")
		return
	}
	if len(res.Items) == 0 || res.Items[0].Type != "Series" {
		http.Error(w, "series not found", http.StatusNotFound)
		return
	}
	series := res.Items[0]

	// Pull every episode of the series via Jellyfin's items endpoint,
	// scoped to the series id server-side via ParentId so the
	// payload is tight even for large libraries.
	epRes, err := fetch(jellyfin.ItemsFilter{
		IncludeItemTypes: []string{"Episode"},
		Recursive:        true,
		ParentID:         id,
		Limit:            10_000,
		SortBy:           "ParentIndexNumber,IndexNumber",
		SortOrder:        "Ascending",
	})
	if err != nil {
		s.logger.Error().Err(err).Msg("episodes: list")
		writeUpstreamError(w, err, "failed to load episodes")
		return
	}
	// Filter client-side to the series' episodes. Jellyfin's
	// IncludeItemTypes=Episode + ParentId is more efficient when
	// supported but our existing client doesn't have ParentId on
	// the filter struct; the post-filter is fine for typical
	// libraries.
	episodes := make([]jellyfin.Item, 0, len(epRes.Items))
	for _, ep := range epRes.Items {
		if ep.SeriesID == id {
			episodes = append(episodes, ep)
		}
	}

	type episodeJSON struct {
		ID           string                 `json:"id"`
		IndexNumber  *int                   `json:"indexNumber,omitempty"`
		Name         string                 `json:"name"`
		RuntimeTicks int64                  `json:"runtimeTicks,omitempty"`
		ImageTag     string                 `json:"imageTag,omitempty"`
		UserData     *jellyfin.ItemUserData `json:"userData,omitempty"`
	}
	type seasonJSON struct {
		SeasonNumber int           `json:"seasonNumber"`
		Episodes     []episodeJSON `json:"episodes"`
	}
	bySeason := map[int]*seasonJSON{}
	seasonOrder := []int{}
	for _, ep := range episodes {
		num := -1
		if ep.ParentIndexNumber != nil {
			num = *ep.ParentIndexNumber
		}
		s, ok := bySeason[num]
		if !ok {
			s = &seasonJSON{SeasonNumber: num}
			bySeason[num] = s
			seasonOrder = append(seasonOrder, num)
		}
		s.Episodes = append(s.Episodes, episodeJSON{
			ID:           ep.ID,
			IndexNumber:  ep.IndexNumber,
			Name:         ep.Name,
			RuntimeTicks: ep.RunTimeTicks,
			ImageTag:     ep.ImageTags.Primary,
			UserData:     ep.UserData,
		})
	}
	sort.Slice(seasonOrder, func(i, j int) bool {
		// Specials (0) at the top; -1 (no season) at the very bottom;
		// other seasons ascending in between.
		a, b := seasonOrder[i], seasonOrder[j]
		if a == 0 {
			return true
		}
		if b == 0 {
			return false
		}
		if a == -1 {
			return false
		}
		if b == -1 {
			return true
		}
		return a < b
	})
	seasons := make([]seasonJSON, 0, len(seasonOrder))
	for _, n := range seasonOrder {
		seasons = append(seasons, *bySeason[n])
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"seriesId":   series.ID,
		"seriesName": series.Name,
		"seasons":    seasons,
	})
}

// kidsPreferredAudioStreamIndex returns the audio-stream index that
// matches the active profile's default language, when such a track
// exists on the item. Returns 0 (= use Jellyfin's default selection)
// when there's no profile resolved, the profile has no language set,
// or the preferred language isn't available on this item.
//
// On the kid bearer path the profile id is implicit (kc.ProfileID).
// On the admin path it must come from ?profileId=, mirroring how
// resolveKidsProfileID handles ambiguity.
func (s *Server) kidsPreferredAudioStreamIndex(ctx context.Context, item *jellyfin.Item, kc *kidsContext, r *http.Request) int {
	if item == nil {
		return 0
	}
	profileID := kc.ProfileID
	if profileID == 0 {
		if v := r.URL.Query().Get("profileId"); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err == nil && n > 0 {
				profileID = n
			}
		}
	}
	if profileID == 0 {
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

// kidsStreamResponse carries the resolved direct-play URL plus enough
// context for the kid client to decide what to do next. SeriesID and
// SeriesName are populated only on Episode items (Jellyfin includes the
// parent series id on Episode item payloads); the client uses SeriesID
// to call /next-up after the current episode finishes.
// ParentIndexNumber + IndexNumber are the season + episode index for
// Episode items, used by the kid player to display "S1E2" alongside
// the episode title.
type kidsStreamResponse struct {
	StreamURL         string                 `json:"streamUrl"`
	ItemID            string                 `json:"itemId"`
	ItemName          string                 `json:"itemName"`
	ItemType          string                 `json:"itemType,omitempty"`
	SeriesID          string                 `json:"seriesId,omitempty"`
	SeriesName        string                 `json:"seriesName,omitempty"`
	ParentIndexNumber *int                   `json:"parentIndexNumber,omitempty"`
	IndexNumber       *int                   `json:"indexNumber,omitempty"`
	// FavoriteItemID is the id the heart-toggle on the player
	// header should target. For movies that's the item itself; for
	// episodes it's the parent series, since favorites surface as
	// browse rows and only series-level entries appear there.
	// IsFavorite reflects the kid's current favorite state for that
	// id. Empty / false on admin preview (no kid context).
	FavoriteItemID string `json:"favoriteItemId,omitempty"`
	IsFavorite     bool   `json:"isFavorite"`
	// ProductionYear is the release / air year for the resolved item.
	// Movies: release year. Episodes: episode air year (Jellyfin
	// populates ProductionYear on episode items as the episode's own
	// year, not the parent series'). Zero when Jellyfin has no year on
	// the item, in which case the client should hide the field.
	ProductionYear int `json:"productionYear,omitempty"`
	// RunTimeTicks is the total length of the resolved item in
	// Jellyfin's 100-nanosecond ticks. Surfaced so the kid client
	// can render the full runtime in the player header (independent
	// of the <video> element's reported duration, which can lag
	// behind the manifest during transcode startup).
	RunTimeTicks int64                  `json:"runtimeTicks,omitempty"`
	UserData     *jellyfin.ItemUserData `json:"userData,omitempty"`
	// MediaSourceID + PlaybackPath echo PlaybackInfo's negotiation
	// back to the client. PlaySessionId is intentionally NOT a separate
	// field: it is embedded as a query parameter in StreamURL itself
	// (Jellyfin's HLS endpoint includes it), and the client extracts it
	// via URLSearchParams - mirrors jellyfin-web's playbackmanager
	// `getParam('playSessionId', mediaUrl)` pattern. The client MUST
	// thread the extracted PlaySessionId on /api/kids/playback/* reports
	// or Jellyfin returns 401 (session-not-found, confusingly rendered
	// as Unauthorized) and silently drops resume tracking.
	MediaSourceID string `json:"mediaSourceId,omitempty"`
	PlaybackPath  string `json:"playbackPath,omitempty"`
}

// handleKidsNextUp resolves the next episode to play for a series for the
// active kid. Requires kid bearer auth (per-user resume + watched-set are
// inherently user-scoped); admin path returns 400.
func (s *Server) handleKidsNextUp(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	if kc.JellyfinToken == "" || kc.JellyfinUserID == "" {
		http.Error(w, "next-up requires kid auth", http.StatusBadRequest)
		return
	}

	ctx, _ := kidsRequestContext(r)
	// ?after=<episodeId> drives the kid player's "Next" button: the
	// resume-aware /Shows/NextUp returns the currently-playing episode
	// while the kid hasn't finished it, so we can't use it to advance.
	// EpisodeAfter walks the series's episode list and returns the one
	// strictly after afterEpisodeID.
	var (
		episode *jellyfin.Item
		err     error
	)
	if after := strings.TrimSpace(r.URL.Query().Get("after")); after != "" {
		episode, err = s.jellyfin.EpisodeAfter(ctx, id, after, kc.JellyfinUserID, kc.JellyfinToken)
	} else {
		episode, err = s.jellyfin.GetNextUp(ctx, id, kc.JellyfinUserID, kc.JellyfinToken)
	}
	if err != nil {
		if errors.Is(err, jellyfin.ErrNotFound) {
			http.Error(w, "no episodes for this series", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Str("series_id", id).Msg("kids next-up")
		writeUpstreamError(w, err, "failed to resolve next-up")
		return
	}

	resp := kidsNextUpResponse{
		EpisodeID:         episode.ID,
		Name:              episode.Name,
		SeriesID:          episode.SeriesID,
		SeriesName:        episode.SeriesName,
		IndexNumber:       episode.IndexNumber,
		ParentIndexNumber: episode.ParentIndexNumber,
	}
	if episode.UserData != nil {
		resp.UserData = episode.UserData
	}
	writeJSON(w, http.StatusOK, resp)
}

type kidsNextUpResponse struct {
	EpisodeID         string                 `json:"episodeId"`
	Name              string                 `json:"name"`
	SeriesID          string                 `json:"seriesId,omitempty"`
	SeriesName        string                 `json:"seriesName,omitempty"`
	// Episode-within-season number; the kid's "Up Next" overlay
	// reads these to render an "S2E04" badge alongside the title.
	IndexNumber       *int                   `json:"indexNumber,omitempty"`
	ParentIndexNumber *int                   `json:"parentIndexNumber,omitempty"`
	UserData          *jellyfin.ItemUserData `json:"userData,omitempty"`
}

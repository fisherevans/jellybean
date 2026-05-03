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
		Source:         "kid",
		Label:          kid.Name,
	}
}

// parseBearer extracts the Jellyfin access token from the Authorization
// header and the Jellyfin user id from X-Jellyfin-User-Id. Both must be
// present for kid auth to succeed.
func parseBearer(r *http.Request) (token, userID string, ok bool) {
	h := r.Header.Get("Authorization")
	if h == "" {
		return "", "", false
	}
	parts := strings.SplitN(h, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], kidsBearerScheme) {
		return "", "", false
	}
	tok := strings.TrimSpace(parts[1])
	uid := strings.TrimSpace(r.Header.Get(kidsUserIDHeader))
	if tok == "" || uid == "" {
		return "", "", false
	}
	return tok, uid, true
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
			http.Error(w, "failed to load continue watching", http.StatusBadGateway)
			return
		}
		visible, err := s.curation.GetStatesForItems(ctx, profileID, itemIDs(res.Items))
		if err != nil {
			s.logger.Error().Err(err).Msg("resume visibility lookup")
			http.Error(w, "failed to load visibility", http.StatusInternalServerError)
			return
		}
		out := make([]jellyfin.Item, 0, len(res.Items))
		for _, it := range res.Items {
			if _, allowed := allowedTypes[it.Type]; !allowed {
				continue
			}
			if visible[it.ID] != curation.StateVisible {
				continue
			}
			out = append(out, it)
			if len(out) >= limit {
				break
			}
		}
		writeJSON(w, http.StatusOK, kidsLibraryResponse{Items: out, ProfileID: profileID})
		return
	}

	ids, err := s.curation.ListItemIDsInState(ctx, profileID, curation.StateVisible, 5000, 0)
	if err != nil {
		s.logger.Error().Err(err).Msg("list visible ids")
		http.Error(w, "failed to load library", http.StatusInternalServerError)
		return
	}
	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, kidsLibraryResponse{ProfileID: profileID})
		return
	}

	sortBy := "SortName"
	sortOrder := "Ascending"
	if section == "recent" {
		sortBy = "DateCreated"
		sortOrder = "Descending"
	}

	res, err := s.jellyfin.GetItemsAsUser(ctx, jellyfin.ItemsFilter{
		IDs:        ids,
		Limit:      limit + startIndex + 50,
		SortBy:     sortBy,
		SortOrder:  sortOrder,
		SearchTerm: search,
	}, kc.JellyfinToken)
	if err != nil {
		s.logger.Error().Err(err).Msg("kids library fetch")
		http.Error(w, "failed to load library", http.StatusBadGateway)
		return
	}

	filtered := make([]jellyfin.Item, 0, len(res.Items))
	for _, it := range res.Items {
		if _, ok := allowedTypes[it.Type]; ok {
			filtered = append(filtered, it)
		}
	}

	end := startIndex + limit
	hasMore := end < len(filtered)
	if startIndex > len(filtered) {
		filtered = nil
	} else {
		if end > len(filtered) {
			end = len(filtered)
		}
		filtered = filtered[startIndex:end]
	}

	writeJSON(w, http.StatusOK, kidsLibraryResponse{
		Items:          filtered,
		TotalAvailable: len(ids),
		StartIndex:     startIndex,
		NextStartIndex: startIndex + len(filtered),
		HasMore:        hasMore,
		ProfileID:      profileID,
	})
}

type kidsLibraryResponse struct {
	Items          []jellyfin.Item `json:"Items"`
	TotalAvailable int             `json:"TotalAvailable,omitempty"`
	StartIndex     int             `json:"StartIndex"`
	NextStartIndex int             `json:"NextStartIndex,omitempty"`
	HasMore        bool            `json:"HasMore,omitempty"`
	ProfileID      int64           `json:"ProfileId"`
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
	MaxSetAt       int64
	JellyfinUserID string
}

// computeKidsLibraryETag returns a weak ETag (W/"...") for the given
// inputs. For section=continue-watching we mix in a per-minute time
// bucket so the resume row refreshes at most once a minute on inactive
// devices but invalidates promptly when the kid plays. This is
// intentional: continue-watching state lives in Jellyfin (resume ticks
// updated by playback reports) and we have no cheap server-side signal
// for "did playback happen since last request", so a coarse clock bucket
// is the cheapest correct invalidator. Don't try to "fix" this by
// removing the time bucket — stale resume rows are a worse failure mode
// than an extra round-trip per minute.
func computeKidsLibraryETag(in kidsLibraryETagInputs) string {
	types := append([]string(nil), in.Types...)
	sort.Strings(types)

	var b strings.Builder
	fmt.Fprintf(&b, "profile=%d;sec=%s;type=%s;limit=%d;start=%d;search=%s;mtime=%d",
		in.ProfileID,
		in.Section,
		strings.Join(types, ","),
		in.Limit,
		in.StartIndex,
		in.Search,
		in.MaxSetAt,
	)
	if in.Section == "continue-watching" {
		fmt.Fprintf(&b, ";userId=%s;tbucket=%d", in.JellyfinUserID, time.Now().Unix()/60)
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
	MediaSourceID    string `json:"mediaSourceId,omitempty"`
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
		PositionTicks:    p.PositionTicks,
		IsPaused:         p.IsPaused,
		AudioStreamIndex: p.AudioStreamIndex,
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("kid", kc.Label).Str("item", p.ItemID).Msg("playback progress report")
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
		PositionTicks: p.PositionTicks,
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("kid", kc.Label).Str("item", p.ItemID).Msg("playback stopped report")
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleKidsStream returns a direct-play stream URL for the requested item.
// Auth: either an admin session cookie or a kid bearer token.
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
		if errors.Is(err, jellyfin.ErrNotFound) {
			http.Error(w, "item not found", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Str("id", id).Msg("kids stream resolve")
		http.Error(w, "failed to resolve item", http.StatusBadGateway)
		return
	}

	streamURL := s.jellyfin.StreamURL(id, kc.JellyfinToken)

	s.logger.Info().
		Str("auth_source", kc.Source).
		Str("auth_label", kc.Label).
		Str("jellyfin_user_id", kc.JellyfinUserID).
		Bool("user_token_used", kc.JellyfinToken != "").
		Str("item_id", id).
		Str("item_name", item.Name).
		Msg("kids stream resolved")

	resp := kidsStreamResponse{
		StreamURL: streamURL,
		ItemID:    id,
		ItemName:  item.Name,
		ItemType:  item.Type,
	}
	if item.UserData != nil {
		resp.UserData = item.UserData
	}
	writeJSON(w, http.StatusOK, resp)
}

type kidsStreamResponse struct {
	StreamURL string                 `json:"streamUrl"`
	ItemID    string                 `json:"itemId"`
	ItemName  string                 `json:"itemName"`
	ItemType  string                 `json:"itemType,omitempty"`
	UserData  *jellyfin.ItemUserData `json:"userData,omitempty"`
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
	episode, err := s.jellyfin.GetNextUp(ctx, id, kc.JellyfinUserID, kc.JellyfinToken)
	if err != nil {
		if errors.Is(err, jellyfin.ErrNotFound) {
			http.Error(w, "no episodes for this series", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Str("series_id", id).Msg("kids next-up")
		http.Error(w, "failed to resolve next-up", http.StatusBadGateway)
		return
	}

	resp := kidsNextUpResponse{
		EpisodeID:  episode.ID,
		Name:       episode.Name,
		SeriesID:   episode.SeriesID,
		SeriesName: episode.SeriesName,
	}
	if episode.UserData != nil {
		resp.UserData = episode.UserData
	}
	writeJSON(w, http.StatusOK, resp)
}

type kidsNextUpResponse struct {
	EpisodeID  string                 `json:"episodeId"`
	Name       string                 `json:"name"`
	SeriesID   string                 `json:"seriesId,omitempty"`
	SeriesName string                 `json:"seriesName,omitempty"`
	UserData   *jellyfin.ItemUserData `json:"userData,omitempty"`
}

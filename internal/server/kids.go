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

const (
	kidsKeyHeader      = "X-Jellybean-Key"
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
	// JellyfinUserID is the user the request will appear as on Jellyfin.
	JellyfinUserID string
	// JellyfinToken is the per-user access token for stream URLs. Empty
	// when we don't have one (admin path or env-var fallback); callers
	// fall back to the service-account key.
	JellyfinToken string
	// ProfileID is the Jellybean profile this caller is associated with.
	// Set automatically from the kid record on key-auth; on admin auth
	// the caller must supply it via ?profileId= since admins aren't
	// scoped to one profile.
	ProfileID int64
	// Source distinguishes the auth path: "admin" (session cookie),
	// "kid_db" (DB-backed key), or "kid_env" (deprecated env-var stub).
	Source string
	// Label is a short identifier for logs.
	Label string
}

// resolveKidsAuth accepts a logged-in admin session OR a kid API key. The
// key is hashed and looked up against the DB-backed kids table first; the
// JELLYBEAN_KIDS_KEYS env var is a deprecated fallback retained for one
// release so M1 setups don't break instantly. Admin sessions short-circuit
// the key flow so testing from a logged-in browser works without
// provisioning a kid.
//
// Returns nil if no acceptable auth was presented; callers should 401.
func (s *Server) resolveKidsAuth(r *http.Request) *kidsContext {
	if sess := auth.SessionFromContext(r.Context()); sess != nil {
		return &kidsContext{
			JellyfinUserID: sess.UserID,
			Source:         "admin",
			Label:          sess.UserName,
		}
	}
	key := r.Header.Get(kidsKeyHeader)
	if key == "" {
		return nil
	}
	if entry, err := s.curation.FindKidByAPIKey(r.Context(), key); err == nil {
		return &kidsContext{
			JellyfinUserID: entry.JellyfinUserID,
			JellyfinToken:  entry.JellyfinToken,
			ProfileID:      entry.ProfileID,
			Source:         "kid_db",
			Label:          entry.Name,
		}
	} else if !errors.Is(err, curation.ErrKidNotFound) {
		s.logger.Error().Err(err).Msg("kid db lookup")
	}
	if userID, ok := s.cfg.KidsKeys[key]; ok {
		s.logger.Warn().Str("jellyfin_user_id", userID).Msg("using deprecated JELLYBEAN_KIDS_KEYS env var; migrate to DB-backed kids")
		return &kidsContext{
			JellyfinUserID: userID,
			Source:         "kid_env",
			Label:          userID,
		}
	}
	return nil
}

// resolveKidsProfileID returns the profile id this caller is acting under.
// For kid-key auth the profile is implicit (the kid record carries it);
// for admin auth it must be supplied via ?profileId= (admins aren't pinned
// to a single profile). Returns 0 + a 4xx error message when ambiguous.
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

// handleKidsLibrary returns the library view for the active kid: visible
// items only, optionally filtered by type, with sub-views for "all",
// "continue-watching", and "recent". Backed by the kid's stored Jellyfin
// token so per-user UserData (resume, played) comes back populated.
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

	// Type filter (default Movie+Series).
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

	// Continue-watching: ask Jellyfin for the kid's resume list, then drop
	// anything not visible for this profile.
	ctx, _ := kidsRequestContext(r)
	if section == "continue-watching" {
		if kc.JellyfinUserID == "" || kc.JellyfinToken == "" {
			// Admin path or env-var stub - we don't have a per-user token,
			// so resume isn't meaningful. Return empty rather than error.
			writeJSON(w, http.StatusOK, kidsLibraryResponse{ProfileID: profileID})
			return
		}
		res, err := s.jellyfin.GetResumeItems(ctx, kc.JellyfinUserID, kc.JellyfinToken, limit*2)
		if err != nil {
			s.logger.Error().Err(err).Msg("kids resume")
			http.Error(w, "failed to load continue watching", http.StatusBadGateway)
			return
		}
		visible, err := s.curation.GetStatesForItems(ctx, profileID,
			itemIDs(res.Items))
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
		writeJSON(w, http.StatusOK, kidsLibraryResponse{
			Items:     out,
			ProfileID: profileID,
		})
		return
	}

	// All / recent: fetch visible IDs from the DB, ask Jellyfin for them
	// in pages so we can sort + filter centrally.
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
		Limit:      limit + startIndex + 50, // overshoot to absorb type/search filtering
		SortBy:     sortBy,
		SortOrder:  sortOrder,
		SearchTerm: search,
	}, kc.JellyfinToken)
	if err != nil {
		s.logger.Error().Err(err).Msg("kids library fetch")
		http.Error(w, "failed to load library", http.StatusBadGateway)
		return
	}

	// Local filter by type (Jellyfin honors IncludeItemTypes only when
	// IDs is unset; with explicit IDs we filter client-side).
	filtered := make([]jellyfin.Item, 0, len(res.Items))
	for _, it := range res.Items {
		if _, ok := allowedTypes[it.Type]; ok {
			filtered = append(filtered, it)
		}
	}

	// Apply pagination on the filtered slice.
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

func itemIDs(items []jellyfin.Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}

// playbackPayload is the wire shape the kid client posts. Lowercase JSON
// because that's what the rest of /api/kids/* uses; we translate to
// Jellyfin's PascalCase in the jellyfin client layer.
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
		// Don't fail the kid's playback over a reporting hiccup; warn and
		// return 204 so the client moves on.
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
// Auth: either an admin session cookie or a valid X-Jellybean-Key.
//
// Response includes the item's UserData when a kid token is present so the
// client can seek to the resume position without a second round trip. On
// the admin / env-var paths UserData is omitted (no per-user context).
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
		// Per-user fetch so UserData (resume) comes back populated.
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
// active kid. Returns 400 when the target item isn't a series; 502 when
// Jellyfin lookup fails. Series resolution requires a per-user token, so
// admin / env-var paths return 400.
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
		http.Error(w, "next-up requires kid auth (no admin / env-var fallback)", http.StatusBadRequest)
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

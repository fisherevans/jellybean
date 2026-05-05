package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/curation"
)

// M10 time-limits endpoints. Three kid-side handlers (status, can-play,
// override grant-time) plus admin-side mirrors used by the manage-kids
// page. The ComputeTimeStatus engine in internal/curation is the
// single source of truth; these handlers do the routing + per-request
// inputs only.

// handleKidsTimeStatus returns the rendered TimeStatus for the active
// kid. Cheap: single-digit queries, no Jellyfin call.
func (s *Server) handleKidsTimeStatus(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	if kc.KidID == 0 {
		// Admin preview: no kid identity. Returning a disabled stub
		// keeps the kid client's render path uniform.
		writeJSON(w, http.StatusOK, &curation.TimeStatus{Enabled: false})
		return
	}
	// Optional ?items=ID,ID... + ?series=ID,ID... so a single call can
	// drive locked-tile rendering for the items currently on screen.
	items := splitNonEmpty(r.URL.Query().Get("items"))
	series := splitNonEmpty(r.URL.Query().Get("series"))
	st, err := s.curation.ComputeTimeStatus(r.Context(), kc.KidID, kc.ProfileID, time.Now().UTC(), items, series)
	if err != nil {
		s.logger.Error().Err(err).Int64("kid", kc.KidID).Msg("time-status compute")
		http.Error(w, "failed to compute time status", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// handleKidsCanPlay is the gate for starting playback. Hit once per
// tile-click (Browse / Library / Watch menu).
func (s *Server) handleKidsCanPlay(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	if kc.KidID == 0 {
		writeJSON(w, http.StatusOK, curation.CanPlayResult{Allowed: true})
		return
	}
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}
	seriesID := r.URL.Query().Get("seriesId")
	res, err := s.curation.CanPlay(r.Context(), kc.KidID, kc.ProfileID, id, seriesID, time.Now().UTC())
	if err != nil {
		s.logger.Error().Err(err).Msg("can-play")
		http.Error(w, "failed to check play permission", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleKidsOverrideGrantTime is the override-gated grant-time action.
// Wired through the same auth chain as the other override actions
// (resolveOverrideAuth: kid bearer + active override session).
func (s *Server) handleKidsOverrideGrantTime(w http.ResponseWriter, r *http.Request) {
	kidID, kc := s.requireOverride(w, r)
	if kidID == 0 || kc == nil {
		return
	}
	var req struct {
		Minutes         int    `json:"minutes,omitempty"`
		Scope           string `json:"scope"`
		ScopeID         string `json:"scopeId,omitempty"`
		UntilEpisodeEnd bool   `json:"untilEpisodeEnd,omitempty"`
		UntilReset      bool   `json:"untilReset,omitempty"`
		EpisodeRemainingSeconds int `json:"episodeRemainingSeconds,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if !curation.IsValidGrantScope(req.Scope) {
		http.Error(w, "scope must be global, item, or series", http.StatusBadRequest)
		return
	}
	now := time.Now().UTC()
	g := curation.TimeGrant{
		KidID:     kidID,
		GrantedAt: now,
		GrantedBy: "override",
		Scope:     req.Scope,
		ScopeID:   req.ScopeID,
	}
	switch {
	case req.UntilReset:
		// MinutesGranted nil + ExpiresAt nil = "until next reset"
		// (the engine substitutes the next day-start crossing).
	case req.UntilEpisodeEnd:
		// Treat as a duration grant whose minutes equal the episode's
		// remaining runtime. The kid client computes
		// EpisodeRemainingSeconds from the player.
		if req.EpisodeRemainingSeconds <= 0 {
			http.Error(w, "untilEpisodeEnd requires episodeRemainingSeconds", http.StatusBadRequest)
			return
		}
		mins := (req.EpisodeRemainingSeconds + 59) / 60
		g.MinutesGranted = &mins
		expires := now.Add(time.Duration(req.EpisodeRemainingSeconds) * time.Second)
		g.ExpiresAt = &expires
	default:
		if req.Minutes <= 0 || req.Minutes > 24*60 {
			http.Error(w, "minutes must be between 1 and 1440", http.StatusBadRequest)
			return
		}
		g.MinutesGranted = &req.Minutes
		// No explicit expiry: clears at next day reset (engine default).
	}
	id, err := s.curation.CreateGrant(r.Context(), g)
	if err != nil {
		s.logger.Error().Err(err).Msg("create grant")
		http.Error(w, "failed to record grant", http.StatusInternalServerError)
		return
	}
	// Audit log via the existing override action sink.
	payload, _ := json.Marshal(req)
	if err := s.curation.RecordOverrideAction(r.Context(), kidID, "grant_time", req.ScopeID, string(payload)); err != nil {
		s.logger.Warn().Err(err).Msg("override audit log")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"grantId":   id,
		"expiresAt": grantExpiry(g),
	})
}

// handleAdminKidTimeStatus mirrors the kid-side time-status endpoint
// for the admin dashboard. Used by the per-kid management page to
// show today's bucket + segments at a glance.
func (s *Server) handleAdminKidTimeStatus(w http.ResponseWriter, r *http.Request) {
	if auth.SessionFromContext(r.Context()) == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	idStr := mux.Vars(r)["id"]
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	kid, err := s.curation.GetKid(r.Context(), id)
	if err != nil {
		http.Error(w, "kid not found", http.StatusNotFound)
		return
	}
	st, err := s.curation.ComputeTimeStatus(r.Context(), kid.ID, kid.ProfileID, time.Now().UTC(), nil, nil)
	if err != nil {
		s.logger.Error().Err(err).Int64("kid", id).Msg("admin time-status")
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// handleAdminProfileTimeLimits returns the current time-limits config
// for a profile.
func (s *Server) handleAdminProfileTimeLimits(w http.ResponseWriter, r *http.Request) {
	if auth.SessionFromContext(r.Context()) == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	idStr := mux.Vars(r)["id"]
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	limits, err := s.curation.GetProfileTimeLimits(r.Context(), id)
	if err != nil {
		s.logger.Error().Err(err).Msg("get profile time limits")
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, limits)
}

// handleAdminUpdateProfileTimeLimits PUTs new config. Body matches the
// JSON shape of curation.ProfileTimeLimits.
func (s *Server) handleAdminUpdateProfileTimeLimits(w http.ResponseWriter, r *http.Request) {
	if auth.SessionFromContext(r.Context()) == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	idStr := mux.Vars(r)["id"]
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	var body struct {
		Enabled               bool `json:"enabled"`
		DailyCapMinutes       int  `json:"dailyCapMinutes"`
		RefillIntervalHours   int  `json:"refillIntervalHours"`
		DayStartHour          int  `json:"dayStartHour"`
		DefaultShowCapMinutes *int `json:"defaultShowCapMinutes,omitempty"`
		DefaultMovieStarts    *int `json:"defaultMovieStarts,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	in := curation.ProfileTimeLimits{
		ProfileID:             id,
		Enabled:               body.Enabled,
		DailyCapMinutes:       body.DailyCapMinutes,
		RefillIntervalHours:   body.RefillIntervalHours,
		DayStartHour:          body.DayStartHour,
		DefaultShowCapMinutes: body.DefaultShowCapMinutes,
		DefaultMovieStarts:    body.DefaultMovieStarts,
	}
	if err := s.curation.UpsertProfileTimeLimits(r.Context(), in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleAdminListContentOverrides returns per-item overrides for a
// profile. Used by the manage-item page to surface "Time" rows.
func (s *Server) handleAdminListContentOverrides(w http.ResponseWriter, r *http.Request) {
	if auth.SessionFromContext(r.Context()) == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	idStr := mux.Vars(r)["id"]
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	overrides, err := s.curation.ListContentOverrides(r.Context(), id)
	if err != nil {
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"overrides": overrides})
}

// handleAdminUpsertContentOverride upserts a per-item override.
func (s *Server) handleAdminUpsertContentOverride(w http.ResponseWriter, r *http.Request) {
	if auth.SessionFromContext(r.Context()) == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	pidStr := mux.Vars(r)["id"]
	pid, err := strconv.ParseInt(pidStr, 10, 64)
	if err != nil || pid <= 0 {
		http.Error(w, "profileId required", http.StatusBadRequest)
		return
	}
	itemID := mux.Vars(r)["itemId"]
	if itemID == "" {
		http.Error(w, "itemId required", http.StatusBadRequest)
		return
	}
	var body struct {
		OverrideCapMinutes *int `json:"overrideCapMinutes,omitempty"`
		OverrideStarts     *int `json:"overrideStarts,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	o := curation.ContentTimeOverride{
		ProfileID:           pid,
		JellyfinItemID:      itemID,
		OverrideCapMinutes:  body.OverrideCapMinutes,
		OverrideStarts:      body.OverrideStarts,
	}
	if err := s.curation.UpsertContentOverride(r.Context(), o); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// splitNonEmpty splits a comma-separated query param into a slice,
// dropping empty fragments.
func splitNonEmpty(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func grantExpiry(g curation.TimeGrant) any {
	if g.ExpiresAt == nil {
		return nil
	}
	return g.ExpiresAt.Format(time.RFC3339)
}

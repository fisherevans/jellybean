package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/curation"
)

// M11 body-breaks endpoints. Three kid-side handlers (status,
// optional manual trigger via override, skip-break) plus admin-side
// CRUD for the profile config. Engine in
// internal/curation/bodybreaks.go.

// handleKidsBodyBreakStatus returns the current break state. Called
// frequently (every progress poll) so cheap is critical; the engine
// does at most two short-keyed queries.
func (s *Server) handleKidsBodyBreakStatus(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	if kc.KidID == 0 {
		writeJSON(w, http.StatusOK, &curation.BodyBreakStatus{Enabled: false})
		return
	}
	st, err := s.curation.GetBodyBreakStatus(r.Context(), kc.KidID, kc.ProfileID, time.Now().UTC())
	if err != nil {
		s.logger.Error().Err(err).Int64("kid", kc.KidID).Msg("body-break status")
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// handleKidsOverrideSkipBreak ends the current break early. Audit
// logged via override_actions (action='skip_break').
func (s *Server) handleKidsOverrideSkipBreak(w http.ResponseWriter, r *http.Request) {
	kidID, _ := s.requireOverride(w, r)
	if kidID == 0 {
		return
	}
	if err := s.curation.EndBreak(r.Context(), kidID, time.Now().UTC(), true); err != nil {
		s.logger.Error().Err(err).Msg("end break")
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	if err := s.curation.RecordOverrideAction(r.Context(), kidID, "skip_break", "", "{}"); err != nil {
		s.logger.Warn().Err(err).Msg("override audit log")
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleAdminProfileBodyBreaks GET returns the per-profile config.
func (s *Server) handleAdminProfileBodyBreaks(w http.ResponseWriter, r *http.Request) {
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
	cfg, err := s.curation.GetProfileBodyBreaks(r.Context(), id)
	if err != nil {
		s.logger.Error().Err(err).Msg("get body breaks")
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

// handleAdminResetProfileBodyBreaks rewrites the row to the canonical
// defaults. Triggered by the "Reset to defaults" button on the body-
// breaks settings tab.
func (s *Server) handleAdminResetProfileBodyBreaks(w http.ResponseWriter, r *http.Request) {
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
	defaults := curation.DefaultProfileBodyBreaks(id)
	if err := s.curation.UpsertProfileBodyBreaks(r.Context(), *defaults); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, defaults)
}

// handleAdminUpdateProfileBodyBreaks PUTs new config.
func (s *Server) handleAdminUpdateProfileBodyBreaks(w http.ResponseWriter, r *http.Request) {
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
		Enabled              bool     `json:"enabled"`
		PlayMinutes          int      `json:"playMinutes"`
		BreakMinutes         int      `json:"breakMinutes"`
		VoiceMessageTemplate string   `json:"voiceMessageTemplate"`
		Reasons              []string `json:"reasons"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	in := curation.ProfileBodyBreaks{
		ProfileID:            id,
		Enabled:              body.Enabled,
		PlayMinutes:          body.PlayMinutes,
		BreakMinutes:         body.BreakMinutes,
		VoiceMessageTemplate: body.VoiceMessageTemplate,
		Reasons:              body.Reasons,
	}
	if err := s.curation.UpsertProfileBodyBreaks(r.Context(), in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

package server

import (
	"net/http"
	"time"

	"github.com/fisherevans/jellybean/internal/curation"
)

// M12 viewing-controls endpoints. Kid SPA polls /viewing-state to
// pick up changes (override expirations, parent-set sleep timer
// firing, clock-based auto-off triggering); admin manages defaults
// per profile; the M9 override modal sets per-kid overrides.

func (s *Server) handleKidsViewingState(w http.ResponseWriter, r *http.Request) {
	kc, _ := KidsContextFromRequest(r)
	if kc.KidID == 0 {
		writeJSON(w, http.StatusOK, &curation.ViewingState{})
		return
	}
	st, err := s.curation.GetViewingState(r.Context(), kc.KidID, kc.ProfileID, time.Now().UTC())
	if err != nil {
		s.logger.Error().Err(err).Int64("kid", kc.KidID).Msg("viewing state")
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// Dim / red-shift / sleep-timer / cancel-auto-off overrides moved
// client-side: web/kids/src/parentOverrides.ts persists the
// device-local layer and the kid client merges it on top of the
// server-reported viewing-state. Server-side helpers
// (SetViewingOverride / SetSleepTimer / CancelAutoOff) stay for
// admin tools that may want to write them later.

func (s *Server) handleAdminProfileViewingControls(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	cfg, err := s.curation.GetProfileViewingControls(r.Context(), id)
	if err != nil {
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) handleAdminUpdateProfileViewingControls(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	body, err := decodeJSON[struct {
		AutoOffClockTime string `json:"autoOffClockTime"`
	}](r, 0)
	if err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	in := curation.ProfileViewingControls{
		ProfileID:        id,
		AutoOffClockTime: body.AutoOffClockTime,
	}
	if err := s.curation.UpsertProfileViewingControls(r.Context(), in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

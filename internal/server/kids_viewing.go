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

// M12 viewing-controls endpoints. Kid SPA polls /viewing-state to
// pick up changes (override expirations, parent-set sleep timer
// firing, clock-based auto-off triggering); admin manages defaults
// per profile; the M9 override modal sets per-kid overrides.

func (s *Server) handleKidsViewingState(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
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

// handleKidsOverrideSetViewing handles dim + red_shift overrides
// + sleep timer + cancel-auto-off via the override flow.
func (s *Server) handleKidsOverrideSetViewing(w http.ResponseWriter, r *http.Request) {
	kidID, _ := s.requireOverride(w, r)
	if kidID == 0 {
		return
	}
	action := mux.Vars(r)["action"]
	now := time.Now().UTC()
	var body struct {
		Value         int    `json:"value"`
		ExpiresInSecs int    `json:"expiresInSecs,omitempty"`
		FireInSecs    int    `json:"fireInSecs,omitempty"`
	}
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
	}
	switch action {
	case "set-dim", "set-red-shift":
		control := "dim"
		if action == "set-red-shift" {
			control = "red_shift"
		}
		var expiresAt time.Time
		if body.ExpiresInSecs > 0 {
			expiresAt = now.Add(time.Duration(body.ExpiresInSecs) * time.Second)
		}
		if err := s.curation.SetViewingOverride(r.Context(), kidID, control, body.Value, expiresAt); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	case "set-sleep-timer":
		if body.FireInSecs <= 0 {
			http.Error(w, "fireInSecs required", http.StatusBadRequest)
			return
		}
		fireAt := now.Add(time.Duration(body.FireInSecs) * time.Second)
		if err := s.curation.SetSleepTimer(r.Context(), kidID, fireAt); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	case "cancel-auto-off":
		if err := s.curation.CancelAutoOff(r.Context(), kidID); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	default:
		http.Error(w, "unknown action", http.StatusNotFound)
		return
	}
	payload, _ := json.Marshal(body)
	if err := s.curation.RecordOverrideAction(r.Context(), kidID, action, "", string(payload)); err != nil {
		s.logger.Warn().Err(err).Msg("override audit log")
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminProfileViewingControls(w http.ResponseWriter, r *http.Request) {
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
	cfg, err := s.curation.GetProfileViewingControls(r.Context(), id)
	if err != nil {
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) handleAdminUpdateProfileViewingControls(w http.ResponseWriter, r *http.Request) {
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
		DimPercent       int    `json:"dimPercent"`
		RedShiftPercent  int    `json:"redShiftPercent"`
		AutoOffClockTime string `json:"autoOffClockTime"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	in := curation.ProfileViewingControls{
		ProfileID:        id,
		DimPercent:       body.DimPercent,
		RedShiftPercent:  body.RedShiftPercent,
		AutoOffClockTime: body.AutoOffClockTime,
	}
	if err := s.curation.UpsertProfileViewingControls(r.Context(), in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

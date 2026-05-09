package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/fisherevans/jellybean/internal/curation"
)

// Admin endpoints for the override PIN (M9 #57) + the public_url
// app_setting that the kid client's QR-code generator uses.

type overrideStatusResponse struct {
	PINSet         bool  `json:"pinSet"`
	FailedAttempts int   `json:"failedAttempts"`
	LockedForSecs  int   `json:"lockedForSeconds"`
	UpdatedAt      int64 `json:"updatedAt"`
}

func (s *Server) handleAdminOverrideStatus(w http.ResponseWriter, r *http.Request) {
	st, err := s.curation.GetOverrideStatus(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, overrideStatusResponse{
		PINSet:         st.PINSet,
		FailedAttempts: st.FailedAttempts,
		LockedForSecs:  int(st.LockedFor.Seconds()),
		UpdatedAt:      st.UpdatedAt.Unix(),
	})
}

// handleAdminSetOverridePIN writes a new PIN. Empty body or empty
// PIN clears the configured PIN (override mode disabled).
func (s *Server) handleAdminSetOverridePIN(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PIN string `json:"pin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// Body is optional; treat decode failure as "clear PIN."
	}
	if err := s.curation.SetPIN(r.Context(), req.PIN); err != nil {
		s.logger.Error().Err(err).Msg("set override pin")
		http.Error(w, "set pin failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleAdminClearOverrideLockout cancels the active lockout window
// without changing the PIN. Used when a parent locks themselves out
// and wants to retry immediately.
func (s *Server) handleAdminClearOverrideLockout(w http.ResponseWriter, r *http.Request) {
	if _, err := s.db.ExecContext(r.Context(), `
		UPDATE override_config
		SET failed_attempts = 0,
		    locked_until = 0,
		    updated_at = unixepoch()
		WHERE id = 1`); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- app settings (cross-cutting key/value) ---------------------------

func (s *Server) handleAdminListSettings(w http.ResponseWriter, r *http.Request) {
	// Whitelist of keys the admin UI exposes. Settings the admin
	// shouldn't be poking from this endpoint (e.g. internal flags)
	// stay out of this list. Source of truth: curation.KnownSettings.
	keys := curation.KnownSettingKeys()
	out := map[string]string{}
	for _, k := range keys {
		v, err := s.curation.AppSettingGet(r.Context(), k)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out[k] = v
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": out})
}

func (s *Server) handleAdminSetSetting(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Key == "" {
		http.Error(w, "key required", http.StatusBadRequest)
		return
	}
	// Same whitelist as ListSettings - admins can only mutate the
	// settings the UI exposes.
	if !curation.IsKnownSetting(req.Key) {
		http.Error(w, "unknown setting key", http.StatusBadRequest)
		return
	}
	if err := s.curation.AppSettingSet(r.Context(), req.Key, req.Value); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// _ used to keep curation visible through this file - other admin
// endpoints typically import it. No-op now.
var _ = curation.ErrPINNotSet
var _ = errors.New

package server

import (
	"net/http"
	"time"

	"github.com/fisherevans/jellybean/internal/curation"
)

// M13: time-based modes admin CRUD + active-mode lookup. Kid-side
// only needs the active-mode endpoint to drive the theme + the
// (deferred) effective-config merge.

func (s *Server) handleAdminListModes(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	modes, err := s.curation.ListModes(r.Context(), id)
	if err != nil {
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	if modes == nil {
		modes = []curation.Mode{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"modes": modes})
}

func (s *Server) handleAdminCreateMode(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	body, err := decodeJSON[curation.Mode](r, 0)
	if err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	body.ProfileID = id
	mode, err := s.curation.CreateMode(r.Context(), body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, mode)
}

func (s *Server) handleAdminUpdateMode(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	body, err := decodeJSON[curation.Mode](r, 0)
	if err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	mode, err := s.curation.UpdateMode(r.Context(), id, body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, mode)
}

func (s *Server) handleAdminDeleteMode(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	if err := s.curation.DeleteMode(r.Context(), id); err != nil {
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleKidsActiveMode(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	if kc.KidID == 0 {
		writeJSON(w, http.StatusOK, &curation.ActiveMode{Source: "none"})
		return
	}
	am, err := s.curation.ResolveActiveMode(r.Context(), kc.KidID, kc.ProfileID, time.Now().UTC())
	if err != nil {
		s.logger.Error().Err(err).Int64("kid", kc.KidID).Msg("active mode")
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, am)
}

// Mode pinning moved client-side: web/kids/src/parentOverrides.ts
// persists the device-local mode override and the kid client
// merges it on top of the server-resolved active mode.

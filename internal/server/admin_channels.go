package server

import (
	"net/http"

	"github.com/fisherevans/jellybean/internal/curation"
)

// M15: cable TV channel CRUD. Per-profile.

func (s *Server) handleAdminListChannels(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	chans, err := s.curation.ListChannels(r.Context(), id)
	if err != nil {
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	if chans == nil {
		chans = []curation.Channel{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": chans})
}

func (s *Server) handleAdminCreateChannel(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	body, err := decodeJSON[curation.Channel](r, 0)
	if err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	body.ProfileID = id
	c, err := s.curation.CreateChannel(r.Context(), body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) handleAdminUpdateChannel(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	body, err := decodeJSON[curation.Channel](r, 0)
	if err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	c, err := s.curation.UpdateChannel(r.Context(), id, body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleAdminDeleteChannel(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	if err := s.curation.DeleteChannel(r.Context(), id); err != nil {
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleKidsChannels returns the channels available to the active
// kid; used by the SPA to render the channel layout row.
func (s *Server) handleKidsChannels(w http.ResponseWriter, r *http.Request) {
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
	chans, err := s.curation.ListChannels(r.Context(), profileID)
	if err != nil {
		http.Error(w, "failed", http.StatusInternalServerError)
		return
	}
	if chans == nil {
		chans = []curation.Channel{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": chans})
}

package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
)

type profileResponse struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	MinAge      int    `json:"minAge"`
	MaxAge      int    `json:"maxAge"`
	CreatedAt   int64  `json:"createdAt"`
	KidCount    int    `json:"kidCount"`
}

func toProfileResponse(p curation.ProfileWithKidCount) profileResponse {
	return profileResponse{
		ID:          p.ID,
		Name:        p.Name,
		Description: p.Description,
		MinAge:      p.MinAge,
		MaxAge:      p.MaxAge,
		CreatedAt:   p.CreatedAt.Unix(),
		KidCount:    p.KidCount,
	}
}

func (s *Server) handleListProfiles(w http.ResponseWriter, r *http.Request) {
	profiles, err := s.curation.ListProfiles(r.Context())
	if err != nil {
		s.logger.Error().Err(err).Msg("list profiles")
		http.Error(w, "failed to list profiles", http.StatusInternalServerError)
		return
	}
	out := make([]profileResponse, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, toProfileResponse(p))
	}
	writeJSON(w, http.StatusOK, map[string]any{"profiles": out})
}

type profileMutation struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	MinAge      int    `json:"minAge"`
	MaxAge      int    `json:"maxAge"`
}

func (s *Server) handleCreateProfile(w http.ResponseWriter, r *http.Request) {
	var req profileMutation
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	p, err := s.curation.CreateProfile(r.Context(), curation.ProfileInput{
		Name:        req.Name,
		Description: req.Description,
		MinAge:      req.MinAge,
		MaxAge:      req.MaxAge,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, toProfileResponse(curation.ProfileWithKidCount{Profile: *p}))
}

func (s *Server) handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(mux.Vars(r)["id"], 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var req profileMutation
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	p, err := s.curation.UpdateProfile(r.Context(), id, curation.ProfileInput{
		Name:        req.Name,
		Description: req.Description,
		MinAge:      req.MinAge,
		MaxAge:      req.MaxAge,
	})
	if err != nil {
		if errors.Is(err, curation.ErrProfileNotFound) {
			http.Error(w, "profile not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, toProfileResponse(curation.ProfileWithKidCount{Profile: *p}))
}

func (s *Server) handleDeleteProfile(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(mux.Vars(r)["id"], 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if err := s.curation.DeleteProfile(r.Context(), id); err != nil {
		switch {
		case errors.Is(err, curation.ErrProfileNotFound):
			http.Error(w, "profile not found", http.StatusNotFound)
		case errors.Is(err, curation.ErrProfileProtected):
			http.Error(w, err.Error(), http.StatusForbidden)
		case errors.Is(err, curation.ErrProfileInUse):
			http.Error(w, err.Error(), http.StatusConflict)
		default:
			s.logger.Error().Err(err).Msg("delete profile")
			http.Error(w, "failed to delete profile", http.StatusInternalServerError)
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

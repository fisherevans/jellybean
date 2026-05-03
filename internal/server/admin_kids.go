package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

type kidResponse struct {
	ID             int64  `json:"id"`
	Name           string `json:"name"`
	ProfileID      int64  `json:"profileId"`
	ProfileName    string `json:"profileName"`
	JellyfinUserID string `json:"jellyfinUserId"`
	HasToken       bool   `json:"hasToken"`
	CreatedAt      int64  `json:"createdAt"`
}

func toKidResponse(k curation.KidWithProfile) kidResponse {
	return kidResponse{
		ID:             k.ID,
		Name:           k.Name,
		ProfileID:      k.ProfileID,
		ProfileName:    k.ProfileName,
		JellyfinUserID: k.JellyfinUserID,
		HasToken:       k.HasToken,
		CreatedAt:      k.CreatedAt.Unix(),
	}
}

func (s *Server) handleListKids(w http.ResponseWriter, r *http.Request) {
	kids, err := s.curation.ListKids(r.Context())
	if err != nil {
		s.logger.Error().Err(err).Msg("list kids")
		http.Error(w, "failed to list kids", http.StatusInternalServerError)
		return
	}
	out := make([]kidResponse, 0, len(kids))
	for _, k := range kids {
		out = append(out, toKidResponse(k))
	}
	writeJSON(w, http.StatusOK, map[string]any{"kids": out})
}

type createKidRequest struct {
	Name             string `json:"name"`
	ProfileID        int64  `json:"profileId"`
	JellyfinUsername string `json:"jellyfinUsername"`
	JellyfinPassword string `json:"jellyfinPassword"`
}

// handleCreateKid mints a Jellyfin token via AuthenticateByName, persists
// the kid row + a freshly generated API key, and returns the raw key
// exactly once. The kid's password never lands in the DB or in any log.
func (s *Server) handleCreateKid(w http.ResponseWriter, r *http.Request) {
	var req createKidRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Name == "" || req.JellyfinUsername == "" || req.JellyfinPassword == "" || req.ProfileID == 0 {
		http.Error(w, "name, profileId, jellyfinUsername, jellyfinPassword required", http.StatusBadRequest)
		return
	}
	auth, err := s.jellyfin.AuthenticateByName(r.Context(), req.JellyfinUsername, req.JellyfinPassword)
	if err != nil {
		if jellyfin.IsUnauthorized(err) {
			http.Error(w, "Jellyfin login failed for that username/password", http.StatusUnauthorized)
			return
		}
		s.logger.Error().Err(err).Msg("kid jellyfin auth")
		http.Error(w, "Jellyfin auth backend error", http.StatusBadGateway)
		return
	}
	res, err := s.curation.CreateKid(r.Context(), curation.CreateKidParams{
		Name:           req.Name,
		ProfileID:      req.ProfileID,
		JellyfinUserID: auth.User.ID,
		JellyfinToken:  auth.AccessToken,
	})
	if err != nil {
		switch {
		case errors.Is(err, curation.ErrKidUserCollision):
			http.Error(w, err.Error(), http.StatusConflict)
		default:
			s.logger.Error().Err(err).Msg("create kid")
			http.Error(w, err.Error(), http.StatusBadRequest)
		}
		return
	}
	s.logger.Info().Int64("kid_id", res.Kid.ID).Str("name", res.Kid.Name).Msg("kid created")

	writeJSON(w, http.StatusCreated, map[string]any{
		"kid":    toKidResponse(*res.Kid),
		"apiKey": res.RawAPIKey, // shown ONCE; the parent must save it
	})
}

func (s *Server) handleRegenerateKidKey(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(mux.Vars(r)["id"], 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	rawKey, err := s.curation.RegenerateAPIKey(r.Context(), id)
	if err != nil {
		if errors.Is(err, curation.ErrKidNotFound) {
			http.Error(w, "kid not found", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Int64("kid_id", id).Msg("regenerate kid key")
		http.Error(w, "failed to regenerate", http.StatusInternalServerError)
		return
	}
	s.logger.Info().Int64("kid_id", id).Msg("kid api key regenerated")
	writeJSON(w, http.StatusOK, map[string]string{"apiKey": rawKey})
}

// handleUpdateKid renames a kid and/or reassigns it to a different
// profile. API key + Jellyfin token are preserved across the update.
// Body: {"name"?, "profileId"?}; at least one must be present.
func (s *Server) handleUpdateKid(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(mux.Vars(r)["id"], 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var req struct {
		Name      string `json:"name"`
		ProfileID int64  `json:"profileId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.curation.UpdateKid(r.Context(), id, req.Name, req.ProfileID); err != nil {
		switch {
		case errors.Is(err, curation.ErrKidNotFound):
			http.Error(w, "kid not found", http.StatusNotFound)
		case errors.Is(err, curation.ErrProfileNotFound):
			http.Error(w, "profile not found", http.StatusBadRequest)
		default:
			s.logger.Error().Err(err).Int64("kid_id", id).Msg("update kid")
			http.Error(w, err.Error(), http.StatusBadRequest)
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteKid(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(mux.Vars(r)["id"], 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if err := s.curation.DeleteKid(r.Context(), id); err != nil {
		if errors.Is(err, curation.ErrKidNotFound) {
			http.Error(w, "kid not found", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Int64("kid_id", id).Msg("delete kid")
		http.Error(w, "failed to delete kid", http.StatusInternalServerError)
		return
	}
	s.logger.Info().Int64("kid_id", id).Msg("kid deleted")
	w.WriteHeader(http.StatusNoContent)
}

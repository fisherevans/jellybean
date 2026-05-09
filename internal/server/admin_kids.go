package server

import (
	"net/http"

	"github.com/fisherevans/jellybean/internal/curation"
)

type kidResponse struct {
	ID             int64  `json:"id"`
	Name           string `json:"name"`
	ProfileID      int64  `json:"profileId"`
	ProfileName    string `json:"profileName"`
	JellyfinUserID string `json:"jellyfinUserId"`
	CreatedAt      int64  `json:"createdAt"`
}

func toKidResponse(k curation.KidWithProfile) kidResponse {
	return kidResponse{
		ID:             k.ID,
		Name:           k.Name,
		ProfileID:      k.ProfileID,
		ProfileName:    k.ProfileName,
		JellyfinUserID: k.JellyfinUserID,
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
	Name           string `json:"name"`
	ProfileID      int64  `json:"profileId"`
	JellyfinUserID string `json:"jellyfinUserId"`
}

// handleCreateKid persists a (jellyfin user -> profile) mapping. Auth
// pivot: no password is collected here. The kid TV will authenticate
// directly with Jellyfin via /api/kids/auth/login on first launch.
func (s *Server) handleCreateKid(w http.ResponseWriter, r *http.Request) {
	req, err := decodeJSON[createKidRequest](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Name == "" || req.JellyfinUserID == "" || req.ProfileID == 0 {
		http.Error(w, "name, profileId, jellyfinUserId required", http.StatusBadRequest)
		return
	}
	kid, err := s.curation.CreateKid(r.Context(), curation.CreateKidParams{
		Name:           req.Name,
		ProfileID:      req.ProfileID,
		JellyfinUserID: req.JellyfinUserID,
	})
	if err != nil {
		if writeDomainError(w, err) {
			return
		}
		s.logger.Error().Err(err).Msg("create kid")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.logger.Info().Int64("kid_id", kid.ID).Str("name", kid.Name).Msg("kid created")
	writeJSON(w, http.StatusCreated, map[string]any{"kid": toKidResponse(*kid)})
}

// handleUpdateKid renames a kid and/or reassigns it to a different
// profile. Body: {"name"?, "profileId"?}; at least one must be present.
func (s *Server) handleUpdateKid(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	req, err := decodeJSON[struct {
		Name      string `json:"name"`
		ProfileID int64  `json:"profileId"`
	}](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.curation.UpdateKid(r.Context(), id, req.Name, req.ProfileID); err != nil {
		if writeDomainError(w, err) {
			return
		}
		s.logger.Error().Err(err).Int64("kid_id", id).Msg("update kid")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteKid(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if err := s.curation.DeleteKid(r.Context(), id); err != nil {
		if writeDomainError(w, err) {
			return
		}
		s.logger.Error().Err(err).Int64("kid_id", id).Msg("delete kid")
		http.Error(w, "failed to delete kid", http.StatusInternalServerError)
		return
	}
	s.logger.Info().Int64("kid_id", id).Msg("kid deleted")
	w.WriteHeader(http.StatusNoContent)
}

// handleListJellyfinUsers powers the admin "create kid" dropdown.
// Returns every Jellyfin user the service-account key can see, with
// flags for is-admin / is-disabled and (computed here) whether the user
// is already mapped to a kid in Jellybean.
func (s *Server) handleListJellyfinUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.jellyfin.ListUsers(r.Context())
	if err != nil {
		s.logger.Error().Err(err).Msg("list jellyfin users")
		http.Error(w, "failed to list jellyfin users", http.StatusBadGateway)
		return
	}
	kids, err := s.curation.ListKids(r.Context())
	if err != nil {
		s.logger.Error().Err(err).Msg("list kids for jellyfin user dropdown")
		http.Error(w, "failed to list kids", http.StatusInternalServerError)
		return
	}
	assigned := make(map[string]string, len(kids))
	for _, k := range kids {
		assigned[k.JellyfinUserID] = k.Name
	}
	type userResp struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		IsAdmin    bool   `json:"isAdmin"`
		IsDisabled bool   `json:"isDisabled"`
		AssignedTo string `json:"assignedTo,omitempty"`
	}
	out := make([]userResp, 0, len(users))
	for _, u := range users {
		out = append(out, userResp{
			ID:         u.ID,
			Name:       u.Name,
			IsAdmin:    u.IsAdmin,
			IsDisabled: u.IsDisabled,
			AssignedTo: assigned[u.ID],
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

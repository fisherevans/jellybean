package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
)

// Admin endpoints for API key management (M14 #90). Bearer-token auth
// extension lives in the auth package; this file owns the CRUD
// surface + access log read.

type apiKeyResponse struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt *int64 `json:"lastUsedAt,omitempty"`
	RevokedAt  *int64 `json:"revokedAt,omitempty"`
}

func toAPIKeyResponse(k curation.APIKey) apiKeyResponse {
	out := apiKeyResponse{
		ID:        k.ID,
		Name:      k.Name,
		CreatedAt: k.CreatedAt.Unix(),
	}
	if k.LastUsedAt != nil {
		t := k.LastUsedAt.Unix()
		out.LastUsedAt = &t
	}
	if k.RevokedAt != nil {
		t := k.RevokedAt.Unix()
		out.RevokedAt = &t
	}
	return out
}

func (s *Server) handleAdminListAPIKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := s.curation.ListAPIKeys(r.Context())
	if err != nil {
		s.logger.Error().Err(err).Msg("list api keys")
		http.Error(w, "failed to list keys", http.StatusInternalServerError)
		return
	}
	out := make([]apiKeyResponse, 0, len(keys))
	for _, k := range keys {
		out = append(out, toAPIKeyResponse(k))
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": out})
}

// handleAdminCreateAPIKey creates a new key and returns the
// plaintext token in the response. The admin UI displays it once
// with a "copy this now, you cannot see it again" warning. We never
// store plaintext server-side.
func (s *Server) handleAdminCreateAPIKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	created, err := s.curation.CreateAPIKey(r.Context(), req.Name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		// "token" is the plaintext - shown once.
		"token": created.Token,
		"key":   toAPIKeyResponse(created.Key),
	})
}

// handleAdminRevokeAPIKey stamps revoked_at. Idempotent.
func (s *Server) handleAdminRevokeAPIKey(w http.ResponseWriter, r *http.Request) {
	id, err := parseIDParam(mux.Vars(r)["id"])
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if err := s.curation.RevokeAPIKey(r.Context(), id); err != nil {
		if errors.Is(err, curation.ErrAPIKeyNotFound) {
			http.Error(w, "key not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleAdminDeleteAPIKey hard-deletes a key. Access log entries
// pointing at it survive (key_id is SET NULL on the cascade).
func (s *Server) handleAdminDeleteAPIKey(w http.ResponseWriter, r *http.Request) {
	id, err := parseIDParam(mux.Vars(r)["id"])
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if err := s.curation.DeleteAPIKey(r.Context(), id); err != nil {
		if errors.Is(err, curation.ErrAPIKeyNotFound) {
			http.Error(w, "key not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type accessLogEntry struct {
	ID         int64  `json:"id"`
	KeyID      *int64 `json:"keyId,omitempty"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	Status     int    `json:"status"`
	OccurredAt int64  `json:"occurredAt"`
}

// handleAdminListAccessLog returns recent access entries, optionally
// filtered to one key via /api/admin/api-keys/{id}/log or the catch-
// all /api/admin/api-keys/log (no id).
func (s *Server) handleAdminListAccessLog(w http.ResponseWriter, r *http.Request) {
	var keyID int64
	if raw, ok := mux.Vars(r)["id"]; ok {
		n, err := parseIDParam(raw)
		if err != nil {
			http.Error(w, "bad id", http.StatusBadRequest)
			return
		}
		keyID = n
	}
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	offset := 0
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}
	entries, err := s.curation.ListAPIAccessLog(r.Context(), keyID, limit, offset)
	if err != nil {
		s.logger.Error().Err(err).Msg("list api access log")
		http.Error(w, "failed to load log", http.StatusInternalServerError)
		return
	}
	out := make([]accessLogEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, accessLogEntry{
			ID:         e.ID,
			KeyID:      e.KeyID,
			Method:     e.Method,
			Path:       e.Path,
			Status:     e.Status,
			OccurredAt: e.OccurredAt.Unix(),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": out})
}

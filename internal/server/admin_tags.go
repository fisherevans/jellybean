package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
)

// parseIDParam parses a positive int64 path parameter (used by every
// /api/admin/{thing}/:id route).
func parseIDParam(raw string) (int64, error) {
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0, errors.New("bad id")
	}
	return n, nil
}

// Admin endpoints for tag management (M6 #35). Tag is a global label
// applied to items - the schema + resolution rules live in
// docs/tags-and-favorites.md.

type tagResponse struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	SortOrder   int    `json:"sortOrder"`
	ItemCount   int    `json:"itemCount"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

func toTagResponse(t curation.TagWithCount) tagResponse {
	return tagResponse{
		ID:          t.ID,
		Name:        t.Name,
		Description: t.Description,
		SortOrder:   t.SortOrder,
		ItemCount:   t.ItemCount,
		CreatedAt:   t.CreatedAt.Unix(),
		UpdatedAt:   t.UpdatedAt.Unix(),
	}
}

func toBareTagResponse(t curation.Tag) tagResponse {
	return tagResponse{
		ID:          t.ID,
		Name:        t.Name,
		Description: t.Description,
		SortOrder:   t.SortOrder,
		CreatedAt:   t.CreatedAt.Unix(),
		UpdatedAt:   t.UpdatedAt.Unix(),
	}
}

// handleListTags handles GET /api/admin/tags. Sorts by name | count |
// recent (default name). The optional ?search= param filters
// case-insensitively on name + description; we apply it post-fetch
// in Go since SQLite's LIKE is already case-insensitive but we want
// to keep the storage layer agnostic of search semantics.
func (s *Server) handleListTags(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sort := curation.TagSortName
	switch q.Get("sort") {
	case "count":
		sort = curation.TagSortCount
	case "recent":
		sort = curation.TagSortRecency
	case "manual":
		sort = curation.TagSortManual
	case "", "name":
		sort = curation.TagSortName
	default:
		http.Error(w, "sort must be name | count | recent | manual", http.StatusBadRequest)
		return
	}

	tags, err := s.curation.ListTags(r.Context(), sort)
	if err != nil {
		s.logger.Error().Err(err).Msg("list tags")
		http.Error(w, "failed to list tags", http.StatusInternalServerError)
		return
	}
	search := normalizeSearch(q.Get("search"))
	out := make([]tagResponse, 0, len(tags))
	for _, t := range tags {
		if search != "" && !tagMatchesSearch(t.Tag, search) {
			continue
		}
		out = append(out, toTagResponse(t))
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": out})
}

// tagMutation is the create / update payload. Description is a *string
// so we can distinguish "unset" (PATCH leaves field) from "" (clear).
type tagMutation struct {
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	SortOrder   *int    `json:"sortOrder,omitempty"`
}

func (s *Server) handleCreateTag(w http.ResponseWriter, r *http.Request) {
	var req tagMutation
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	in := curation.TagInput{Name: req.Name}
	if req.Description != nil {
		in.Description = *req.Description
	}
	if req.SortOrder != nil {
		in.SortOrder = *req.SortOrder
	}
	tag, err := s.curation.CreateTag(r.Context(), in)
	if err != nil {
		switch {
		case errors.Is(err, curation.ErrTagNameTaken):
			http.Error(w, err.Error(), http.StatusConflict)
		default:
			http.Error(w, err.Error(), http.StatusBadRequest)
		}
		return
	}
	writeJSON(w, http.StatusCreated, toBareTagResponse(*tag))
}

func (s *Server) handleUpdateTag(w http.ResponseWriter, r *http.Request) {
	id, err := parseIDParam(mux.Vars(r)["id"])
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var req tagMutation
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Fetch existing for the merge-with-current pattern: callers
	// using PATCH with a partial body shouldn't have to send every
	// field. Mirrors how profileMutation is handled in admin_profiles.go.
	existing, err := s.curation.GetTag(r.Context(), id)
	if err != nil {
		if errors.Is(err, curation.ErrTagNotFound) {
			http.Error(w, "tag not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	in := curation.TagInput{
		Name:        existing.Name,
		Description: existing.Description,
		SortOrder:   existing.SortOrder,
	}
	if req.Name != "" {
		in.Name = req.Name
	}
	if req.Description != nil {
		in.Description = *req.Description
	}
	if req.SortOrder != nil {
		in.SortOrder = *req.SortOrder
	}
	tag, err := s.curation.UpdateTag(r.Context(), id, in)
	if err != nil {
		switch {
		case errors.Is(err, curation.ErrTagNotFound):
			http.Error(w, "tag not found", http.StatusNotFound)
		case errors.Is(err, curation.ErrTagNameTaken):
			http.Error(w, err.Error(), http.StatusConflict)
		default:
			http.Error(w, err.Error(), http.StatusBadRequest)
		}
		return
	}
	writeJSON(w, http.StatusOK, toBareTagResponse(*tag))
}

func (s *Server) handleDeleteTag(w http.ResponseWriter, r *http.Request) {
	id, err := parseIDParam(mux.Vars(r)["id"])
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if err := s.curation.DeleteTag(r.Context(), id); err != nil {
		if errors.Is(err, curation.ErrTagNotFound) {
			http.Error(w, "tag not found", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Msg("delete tag")
		http.Error(w, "failed to delete tag", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// normalizeSearch trims + lowercases for case-insensitive substring
// matching. Empty input -> empty output (caller skips filter).
func normalizeSearch(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		s = s[:200]
	}
	return strings.ToLower(s)
}

func tagMatchesSearch(t curation.Tag, search string) bool {
	if search == "" {
		return true
	}
	if strings.Contains(strings.ToLower(t.Name), search) {
		return true
	}
	if strings.Contains(strings.ToLower(t.Description), search) {
		return true
	}
	return false
}

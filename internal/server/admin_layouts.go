package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/fisherevans/jellybean/internal/curation"
)

// Admin endpoints for layout + row management (M8 #46/#47/#50). The
// resolver lives in browse_resolver.go; here we wire HTTP shapes
// around it.

type layoutResponse struct {
	ID           int64           `json:"id"`
	Name         string          `json:"name"`
	Description  string          `json:"description,omitempty"`
	IsDefault    bool            `json:"isDefault"`
	ProfileCount int             `json:"profileCount"`
	Rows         []layoutRowJSON `json:"rows"`
	CreatedAt    int64           `json:"createdAt"`
	UpdatedAt    int64           `json:"updatedAt"`
}

type layoutRowJSON struct {
	ID         int64           `json:"id"`
	Position   int             `json:"position"`
	Type       string          `json:"type"`
	Title      string          `json:"title,omitempty"`
	ConfigJSON json.RawMessage `json:"config"`
	CreatedAt  int64           `json:"createdAt"`
	UpdatedAt  int64           `json:"updatedAt"`
}

func toLayoutResponse(lw curation.LayoutWithRows) layoutResponse {
	rows := make([]layoutRowJSON, 0, len(lw.Rows))
	for _, r := range lw.Rows {
		rows = append(rows, layoutRowJSON{
			ID:         r.ID,
			Position:   r.Position,
			Type:       string(r.Type),
			Title:      r.Title,
			ConfigJSON: json.RawMessage(r.ConfigJSON),
			CreatedAt:  r.CreatedAt.Unix(),
			UpdatedAt:  r.UpdatedAt.Unix(),
		})
	}
	return layoutResponse{
		ID:           lw.ID,
		Name:         lw.Name,
		Description:  lw.Description,
		IsDefault:    lw.IsDefault,
		ProfileCount: lw.ProfileCount,
		Rows:         rows,
		CreatedAt:    lw.CreatedAt.Unix(),
		UpdatedAt:    lw.UpdatedAt.Unix(),
	}
}

func (s *Server) handleAdminListLayouts(w http.ResponseWriter, r *http.Request) {
	all, err := s.curation.ListLayouts(r.Context())
	if err != nil {
		s.logger.Error().Err(err).Msg("list layouts")
		http.Error(w, "failed to list layouts", http.StatusInternalServerError)
		return
	}
	out := make([]layoutResponse, 0, len(all))
	for _, l := range all {
		out = append(out, toLayoutResponse(l))
	}
	writeJSON(w, http.StatusOK, map[string]any{"layouts": out})
}

func (s *Server) handleAdminGetLayout(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	lw, err := s.curation.GetLayoutWithRows(r.Context(), id)
	if err != nil {
		if writeDomainError(w, err) {
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Decorate with the profile-count too (GetLayoutWithRows doesn't
	// pull it; ListLayouts does). One-off query is fine here.
	var n int
	if err := s.db.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM profiles WHERE layout_id = ?`, id).Scan(&n); err == nil {
		lw.ProfileCount = n
	}
	writeJSON(w, http.StatusOK, toLayoutResponse(*lw))
}

type layoutMutation struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (s *Server) handleAdminCreateLayout(w http.ResponseWriter, r *http.Request) {
	req, err := decodeJSON[layoutMutation](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	l, err := s.curation.CreateLayout(r.Context(), curation.LayoutInput{
		Name:        req.Name,
		Description: req.Description,
	})
	if err != nil {
		if writeDomainError(w, err) {
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, toLayoutResponse(curation.LayoutWithRows{Layout: *l}))
}

func (s *Server) handleAdminUpdateLayout(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	req, err := decodeJSON[layoutMutation](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	l, err := s.curation.UpdateLayout(r.Context(), id, curation.LayoutInput{
		Name:        req.Name,
		Description: req.Description,
	})
	if err != nil {
		if writeDomainError(w, err) {
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, toLayoutResponse(curation.LayoutWithRows{Layout: *l}))
}

func (s *Server) handleAdminDeleteLayout(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if err := s.curation.DeleteLayout(r.Context(), id); err != nil {
		if writeDomainError(w, err) {
			return
		}
		// in-use error from the storage layer is a plain Errorf;
		// surface as 409 Conflict.
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminCloneLayout(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	// Body is optional; an empty / unparseable body just means
	// "use a generated name."
	req, _ := decodeJSON[struct {
		Name string `json:"name"`
	}](r, 0)
	l, err := s.curation.CloneLayout(r.Context(), id, req.Name)
	if err != nil {
		if writeDomainError(w, err) {
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, toLayoutResponse(curation.LayoutWithRows{Layout: *l}))
}

func (s *Server) handleAdminSetDefaultLayout(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if err := s.curation.SetDefaultLayout(r.Context(), id); err != nil {
		if writeDomainError(w, err) {
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- row endpoints ------------------------------------------------------

type rowMutation struct {
	Type       string          `json:"type"`
	Title      string          `json:"title"`
	ConfigJSON json.RawMessage `json:"config"`
}

func (s *Server) handleAdminAppendRow(w http.ResponseWriter, r *http.Request) {
	layoutID, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	req, err := decodeJSON[rowMutation](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	row, err := s.curation.AppendRow(r.Context(), layoutID, curation.LayoutRowInput{
		Type:       curation.RowType(req.Type),
		Title:      req.Title,
		ConfigJSON: string(req.ConfigJSON),
	})
	if err != nil {
		if writeDomainError(w, err) {
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, layoutRowJSON{
		ID:         row.ID,
		Position:   row.Position,
		Type:       string(row.Type),
		Title:      row.Title,
		ConfigJSON: json.RawMessage(row.ConfigJSON),
		CreatedAt:  row.CreatedAt.Unix(),
		UpdatedAt:  row.UpdatedAt.Unix(),
	})
}

func (s *Server) handleAdminUpdateRow(w http.ResponseWriter, r *http.Request) {
	rowID, err := pathID(r, "rowId")
	if err != nil {
		http.Error(w, "bad row id", http.StatusBadRequest)
		return
	}
	req, err := decodeJSON[rowMutation](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	row, err := s.curation.UpdateRow(r.Context(), rowID, curation.LayoutRowInput{
		Type:       curation.RowType(req.Type),
		Title:      req.Title,
		ConfigJSON: string(req.ConfigJSON),
	})
	if err != nil {
		if writeDomainError(w, err) {
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, layoutRowJSON{
		ID:         row.ID,
		Position:   row.Position,
		Type:       string(row.Type),
		Title:      row.Title,
		ConfigJSON: json.RawMessage(row.ConfigJSON),
		CreatedAt:  row.CreatedAt.Unix(),
		UpdatedAt:  row.UpdatedAt.Unix(),
	})
}

func (s *Server) handleAdminDeleteRow(w http.ResponseWriter, r *http.Request) {
	rowID, err := pathID(r, "rowId")
	if err != nil {
		http.Error(w, "bad row id", http.StatusBadRequest)
		return
	}
	if err := s.curation.DeleteRow(r.Context(), rowID); err != nil {
		if writeDomainError(w, err) {
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminReorderRows(w http.ResponseWriter, r *http.Request) {
	layoutID, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	req, err := decodeJSON[struct {
		RowIDs []int64 `json:"rowIds"`
	}](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.curation.ReorderRows(r.Context(), layoutID, req.RowIDs); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- profile -> layout assignment --------------------------------------

func (s *Server) handleAdminSetProfileLayout(w http.ResponseWriter, r *http.Request) {
	profileID, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad profile id", http.StatusBadRequest)
		return
	}
	req, err := decodeJSON[struct {
		LayoutID int64 `json:"layoutId"`
	}](r, 0)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.curation.SetProfileLayout(r.Context(), profileID, req.LayoutID); err != nil {
		// ErrLayoutNotFound here describes a bad body field, not a
		// missing URL resource - keep the legacy 400-not-404 surface.
		if errors.Is(err, curation.ErrLayoutNotFound) {
			http.Error(w, "layout not found", http.StatusBadRequest)
			return
		}
		if writeDomainError(w, err) {
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- preview + dev refresh ---------------------------------------------

// handleAdminLayoutPreview resolves a layout against an arbitrary
// profile and returns the same shape the kid endpoint produces, so
// the editor can preview without changing assignments.
//
// Auth: admin cookie. UserID/UserToken are empty so per-user rows
// (continue_watching, watch_again) come back empty - the admin
// preview is a "structural" preview, not a real user view.
func (s *Server) handleAdminLayoutPreview(w http.ResponseWriter, r *http.Request) {
	layoutID, err := pathID(r, "id")
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	profileID, ok := requireProfileID(w, r)
	if !ok {
		return
	}
	s.respondBrowse(w, r, profileID, layoutID, 0, "", "")
}

// handleAdminRefreshLayoutCache clears the cached randomized
// orderings for a profile. Used by the hidden /admin/dev menu's
// "force refresh" button.
func (s *Server) handleAdminRefreshLayoutCache(w http.ResponseWriter, r *http.Request) {
	profileID, ok := requireProfileID(w, r)
	if !ok {
		return
	}
	if err := s.curation.InvalidateProfileLayoutCache(r.Context(), profileID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

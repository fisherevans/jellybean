package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
)

// HTTP-level smoke for the M8 layout endpoints. The storage layer is
// covered by curation/layouts_test.go; this file checks the wire
// shapes + auth + happy-path flows.

func TestAdminLayoutListContainsSeededDefault(t *testing.T) {
	srv, store := newTestServer(t, nil)

	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/layouts", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list -> %d body %s", rec.Code, rec.Body.String())
	}
	var listed struct {
		Layouts []struct {
			ID        int64
			Name      string
			IsDefault bool `json:"isDefault"`
			Rows      []struct {
				Type     string
				Position int
			}
		}
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Layouts) != 1 {
		t.Fatalf("seed should produce 1 layout, got %d", len(listed.Layouts))
	}
	if listed.Layouts[0].Name != "Default" || !listed.Layouts[0].IsDefault {
		t.Errorf("seeded layout wrong: %+v", listed.Layouts[0])
	}
	if len(listed.Layouts[0].Rows) != 5 {
		t.Errorf("seeded default should have 5 rows, got %d", len(listed.Layouts[0].Rows))
	}
}

func TestAdminLayoutCRUDFlow(t *testing.T) {
	srv, store := newTestServer(t, nil)

	// Create.
	body, _ := json.Marshal(map[string]string{"name": "TestLayout", "description": "for tests"})
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/layouts", bytes.NewReader(body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create -> %d body %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	json.Unmarshal(rec.Body.Bytes(), &created)
	if created.ID == 0 {
		t.Fatal("expected nonzero id")
	}

	// Append a row.
	rowBody, _ := json.Marshal(map[string]any{
		"type":   "tag",
		"title":  "Adventure",
		"config": map[string]any{"tag_id": 1, "max_items": 10},
	})
	rec = authedRequest(t, srv, store, http.MethodPost,
		"/api/admin/layouts/"+strconv.FormatInt(created.ID, 10)+"/rows",
		bytes.NewReader(rowBody))
	if rec.Code != http.StatusCreated {
		t.Fatalf("append row -> %d body %s", rec.Code, rec.Body.String())
	}
	var addedRow struct {
		ID       int64
		Position int
		Type     string
	}
	json.Unmarshal(rec.Body.Bytes(), &addedRow)
	if addedRow.Type != "tag" || addedRow.Position != 0 {
		t.Errorf("append row wrong: %+v", addedRow)
	}

	// Re-fetch full layout, confirm row is there.
	rec = authedRequest(t, srv, store, http.MethodGet,
		"/api/admin/layouts/"+strconv.FormatInt(created.ID, 10), nil)
	var full struct {
		Rows []struct {
			Type string
		}
	}
	json.Unmarshal(rec.Body.Bytes(), &full)
	if len(full.Rows) != 1 || full.Rows[0].Type != "tag" {
		t.Errorf("full layout rows wrong: %+v", full.Rows)
	}

	// Delete the layout.
	rec = authedRequest(t, srv, store, http.MethodDelete,
		"/api/admin/layouts/"+strconv.FormatInt(created.ID, 10), nil)
	if rec.Code != http.StatusNoContent {
		t.Errorf("delete -> %d body %s", rec.Code, rec.Body.String())
	}
}

func TestAdminDeleteSeededDefaultBlocked(t *testing.T) {
	srv, store := newTestServer(t, nil)
	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/layouts", nil)
	var listed struct {
		Layouts []struct {
			ID int64
		}
	}
	json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Layouts) == 0 {
		t.Fatal("no layouts")
	}
	defID := listed.Layouts[0].ID

	rec = authedRequest(t, srv, store, http.MethodDelete,
		"/api/admin/layouts/"+strconv.FormatInt(defID, 10), nil)
	if rec.Code != http.StatusForbidden {
		t.Errorf("delete default -> %d, want 403", rec.Code)
	}
}


package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestAdminTagsRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/admin/tags", nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated GET /api/admin/tags -> %d, want 401", rec.Code)
	}
}

func TestAdminTagCRUDFlow(t *testing.T) {
	srv, store := newTestServer(t, nil)

	// Create.
	body, _ := json.Marshal(map[string]any{
		"name":        "Adventure",
		"description": "Big-feel stories",
		"sortOrder":   10,
	})
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/tags", bytes.NewReader(body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create -> %d body %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == 0 {
		t.Fatal("expected non-zero id")
	}

	// Duplicate name -> 409.
	rec = authedRequest(t, srv, store, http.MethodPost, "/api/admin/tags", bytes.NewReader(body))
	if rec.Code != http.StatusConflict {
		t.Errorf("duplicate name -> %d, want 409", rec.Code)
	}

	// Patch with a partial body (only description); name + sortOrder
	// should preserve.
	patch, _ := json.Marshal(map[string]any{"description": "renamed"})
	rec = authedRequest(t, srv, store, http.MethodPatch, "/api/admin/tags/"+strconv.FormatInt(created.ID, 10), bytes.NewReader(patch))
	if rec.Code != http.StatusOK {
		t.Fatalf("patch -> %d body %s", rec.Code, rec.Body.String())
	}
	var patched struct {
		Name, Description string
		SortOrder         int `json:"sortOrder"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &patched); err != nil {
		t.Fatal(err)
	}
	if patched.Name != "Adventure" {
		t.Errorf("name should remain Adventure after partial patch, got %q", patched.Name)
	}
	if patched.Description != "renamed" {
		t.Errorf("description should be renamed, got %q", patched.Description)
	}
	if patched.SortOrder != 10 {
		t.Errorf("sortOrder should remain 10 after partial patch, got %d", patched.SortOrder)
	}

	// List.
	rec = authedRequest(t, srv, store, http.MethodGet, "/api/admin/tags", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list -> %d", rec.Code)
	}
	var listed struct {
		Tags []struct {
			ID        int64
			Name      string
			ItemCount int `json:"itemCount"`
		}
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Tags) != 1 || listed.Tags[0].Name != "Adventure" {
		t.Errorf("listed tags wrong: %+v", listed.Tags)
	}
	if listed.Tags[0].ItemCount != 0 {
		t.Errorf("itemCount on fresh tag should be 0, got %d", listed.Tags[0].ItemCount)
	}

	// Delete.
	rec = authedRequest(t, srv, store, http.MethodDelete, "/api/admin/tags/"+strconv.FormatInt(created.ID, 10), nil)
	if rec.Code != http.StatusNoContent {
		t.Errorf("delete -> %d", rec.Code)
	}
	rec = authedRequest(t, srv, store, http.MethodGet, "/api/admin/tags", nil)
	json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Tags) != 0 {
		t.Errorf("expected empty list after delete, got %+v", listed.Tags)
	}
}

func TestAdminTagSearchFilters(t *testing.T) {
	srv, store := newTestServer(t, nil)
	for _, name := range []string{"Adventure", "Bedtime", "Comedy"} {
		body, _ := json.Marshal(map[string]any{"name": name})
		rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/tags", bytes.NewReader(body))
		if rec.Code != http.StatusCreated {
			t.Fatalf("create %q -> %d", name, rec.Code)
		}
	}

	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/tags?search=bed", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("search -> %d", rec.Code)
	}
	var listed struct {
		Tags []struct {
			Name string
		}
	}
	json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Tags) != 1 || listed.Tags[0].Name != "Bedtime" {
		t.Errorf("search=bed -> %+v", listed.Tags)
	}
}

func TestAdminTagBadSortRejected(t *testing.T) {
	srv, store := newTestServer(t, nil)
	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/tags?sort=bogus", nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad sort -> %d, want 400", rec.Code)
	}
}

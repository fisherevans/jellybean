package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
)

func TestAdminProfileTagFiltersPutAndDelete(t *testing.T) {
	srv, store := newTestServer(t, nil)
	profileID := defaultProfileID(t, srv)

	scary := createTagViaAPI(t, srv, store, "Scary")
	bedtime := createTagViaAPI(t, srv, store, "Bedtime")

	// PUT [{scary, always_hidden}, {bedtime, always_visible}].
	body, _ := json.Marshal([]map[string]any{
		{"tagId": scary, "mode": "always_hidden"},
		{"tagId": bedtime, "mode": "always_visible"},
	})
	rec := authedRequest(t, srv, store, http.MethodPut,
		"/api/admin/profiles/"+strconv.FormatInt(profileID, 10)+"/tag-filters",
		bytes.NewReader(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT -> %d body %s", rec.Code, rec.Body.String())
	}

	rec = authedRequest(t, srv, store, http.MethodGet,
		"/api/admin/profiles/"+strconv.FormatInt(profileID, 10)+"/tag-filters", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET -> %d", rec.Code)
	}
	var listed struct {
		Filters []struct {
			TagID   int64
			TagName string
			Mode    string
		}
	}
	json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Filters) != 2 {
		t.Fatalf("want 2 filters, got %+v", listed.Filters)
	}

	// PUT with subset replaces (Bedtime drops out).
	body, _ = json.Marshal([]map[string]any{
		{"tagId": scary, "mode": "always_visible"},
	})
	rec = authedRequest(t, srv, store, http.MethodPut,
		"/api/admin/profiles/"+strconv.FormatInt(profileID, 10)+"/tag-filters",
		bytes.NewReader(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT subset -> %d body %s", rec.Code, rec.Body.String())
	}
	json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Filters) != 1 || listed.Filters[0].TagName != "Scary" || listed.Filters[0].Mode != "always_visible" {
		t.Errorf("subset replace wrong: %+v", listed.Filters)
	}

	// DELETE single filter.
	rec = authedRequest(t, srv, store, http.MethodDelete,
		"/api/admin/profiles/"+strconv.FormatInt(profileID, 10)+"/tag-filters/"+strconv.FormatInt(scary, 10), nil)
	if rec.Code != http.StatusNoContent {
		t.Errorf("DELETE -> %d", rec.Code)
	}
	rec = authedRequest(t, srv, store, http.MethodGet,
		"/api/admin/profiles/"+strconv.FormatInt(profileID, 10)+"/tag-filters", nil)
	json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Filters) != 0 {
		t.Errorf("expected empty after delete, got %+v", listed.Filters)
	}
}

func TestAdminProfileTagFiltersValidation(t *testing.T) {
	srv, store := newTestServer(t, nil)
	profileID := defaultProfileID(t, srv)

	// Unknown tag id.
	body, _ := json.Marshal([]map[string]any{
		{"tagId": 9999, "mode": "always_hidden"},
	})
	rec := authedRequest(t, srv, store, http.MethodPut,
		"/api/admin/profiles/"+strconv.FormatInt(profileID, 10)+"/tag-filters",
		bytes.NewReader(body))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("unknown tag -> %d, want 400", rec.Code)
	}

	// Bad mode.
	tagID := createTagViaAPI(t, srv, store, "Adventure")
	body, _ = json.Marshal([]map[string]any{
		{"tagId": tagID, "mode": "bogus"},
	})
	rec = authedRequest(t, srv, store, http.MethodPut,
		"/api/admin/profiles/"+strconv.FormatInt(profileID, 10)+"/tag-filters",
		bytes.NewReader(body))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad mode -> %d, want 400", rec.Code)
	}

	// Duplicate tagId.
	body, _ = json.Marshal([]map[string]any{
		{"tagId": tagID, "mode": "always_visible"},
		{"tagId": tagID, "mode": "always_hidden"},
	})
	rec = authedRequest(t, srv, store, http.MethodPut,
		"/api/admin/profiles/"+strconv.FormatInt(profileID, 10)+"/tag-filters",
		bytes.NewReader(body))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("duplicate tagId -> %d, want 400", rec.Code)
	}
}

func TestAdminProfileTagFiltersUnknownProfile(t *testing.T) {
	srv, store := newTestServer(t, nil)
	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/profiles/9999/tag-filters", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown profile -> %d, want 404", rec.Code)
	}
}


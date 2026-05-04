package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/curation"
)

// createTagViaAPI is a small helper - tests that need a tag in the DB
// to operate on want it via the API path so we exercise the handler.
func createTagViaAPI(t *testing.T, srv *Server, store *auth.SessionStore, name string) int64 {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"name": name})
	rec := authedRequest(t, srv, store, http.MethodPost, "/api/admin/tags", bytes.NewReader(body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create tag %q -> %d body %s", name, rec.Code, rec.Body.String())
	}
	var out struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.ID
}

func TestAdminGetItemTags(t *testing.T) {
	library := makeItems(3)
	srv, store := newTestServer(t, library)

	tagID := createTagViaAPI(t, srv, store, "Adventure")
	curStore := curation.NewStore(srv.db)
	if err := curStore.AddItemTag(context.Background(), library[0].ID, tagID, "admin"); err != nil {
		t.Fatal(err)
	}

	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/items/"+library[0].ID+"/tags", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get tags -> %d", rec.Code)
	}
	var got struct {
		Tags []struct {
			ID   int64
			Name string
		}
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Tags) != 1 || got.Tags[0].Name != "Adventure" {
		t.Errorf("tags wrong: %+v", got.Tags)
	}
}

func TestAdminSetItemTagsReplaces(t *testing.T) {
	library := makeItems(3)
	srv, store := newTestServer(t, library)

	a := createTagViaAPI(t, srv, store, "A")
	b := createTagViaAPI(t, srv, store, "B")
	c := createTagViaAPI(t, srv, store, "C")

	// Mark item-0000 visible for some profile so it passes the
	// visible-only guard.
	curStore := curation.NewStore(srv.db)
	visible := curation.StateVisible
	if _, err := curStore.SetState(t.Context(), library[0].ID, defaultProfileID(t, srv), &visible, "admin"); err != nil {
		t.Fatal(err)
	}

	// PUT {a, b}.
	body, _ := json.Marshal(map[string]any{"tagIds": []int64{a, b}})
	rec := authedRequest(t, srv, store, http.MethodPut, "/api/admin/items/"+library[0].ID+"/tags", bytes.NewReader(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("put -> %d body %s", rec.Code, rec.Body.String())
	}

	// PUT {b, c} replaces; a should be gone, c should be added.
	body, _ = json.Marshal(map[string]any{"tagIds": []int64{b, c}})
	rec = authedRequest(t, srv, store, http.MethodPut, "/api/admin/items/"+library[0].ID+"/tags", bytes.NewReader(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("put replace -> %d body %s", rec.Code, rec.Body.String())
	}

	tags, _ := curStore.GetTagsForItem(t.Context(), library[0].ID)
	if len(tags) != 2 {
		t.Fatalf("want 2 tags after replace, got %d (%+v)", len(tags), tags)
	}
	names := map[string]bool{}
	for _, x := range tags {
		names[x.Name] = true
	}
	if names["A"] || !names["B"] || !names["C"] {
		t.Errorf("expected B+C only, got %+v", names)
	}

	// Empty body clears even on hidden-only items - cleanup path.
	body, _ = json.Marshal(map[string]any{"tagIds": []int64{}})
	rec = authedRequest(t, srv, store, http.MethodPut, "/api/admin/items/"+library[0].ID+"/tags", bytes.NewReader(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("put empty -> %d body %s", rec.Code, rec.Body.String())
	}
	tags, _ = curStore.GetTagsForItem(t.Context(), library[0].ID)
	if len(tags) != 0 {
		t.Errorf("clear should empty tag list, got %+v", tags)
	}
}

func TestAdminSetItemTagsRejectsUnknownIDs(t *testing.T) {
	library := makeItems(2)
	srv, store := newTestServer(t, library)

	curStore := curation.NewStore(srv.db)
	visible := curation.StateVisible
	curStore.SetState(t.Context(), library[0].ID, defaultProfileID(t, srv), &visible, "admin")

	body, _ := json.Marshal(map[string]any{"tagIds": []int64{9999}})
	rec := authedRequest(t, srv, store, http.MethodPut, "/api/admin/items/"+library[0].ID+"/tags", bytes.NewReader(body))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("unknown tag id -> %d, want 400", rec.Code)
	}
}

func TestAdminSetItemTagsBlocksHiddenWithoutForce(t *testing.T) {
	library := makeItems(2)
	srv, store := newTestServer(t, library)
	tagID := createTagViaAPI(t, srv, store, "Adventure")

	// item-0000 has no categorization for any profile -> not visible
	// for any. Setting tags should be 409 without ?force=true.
	body, _ := json.Marshal(map[string]any{"tagIds": []int64{tagID}})
	rec := authedRequest(t, srv, store, http.MethodPut, "/api/admin/items/"+library[0].ID+"/tags", bytes.NewReader(body))
	if rec.Code != http.StatusConflict {
		t.Fatalf("hidden-only tag set -> %d, want 409 body %s", rec.Code, rec.Body.String())
	}

	// With ?force=true the same call succeeds.
	rec = authedRequest(t, srv, store, http.MethodPut, "/api/admin/items/"+library[0].ID+"/tags?force=true", bytes.NewReader(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("force=true tag set -> %d body %s", rec.Code, rec.Body.String())
	}
}

func TestAdminItemsFilterByTagId(t *testing.T) {
	library := makeItems(50)
	srv, store := newTestServer(t, library)
	a := createTagViaAPI(t, srv, store, "Adventure")
	b := createTagViaAPI(t, srv, store, "Comedy")

	curStore := curation.NewStore(srv.db)
	ctx := t.Context()
	for i := 0; i < 5; i++ {
		if err := curStore.AddItemTag(ctx, library[i].ID, a, ""); err != nil {
			t.Fatal(err)
		}
	}
	for i := 5; i < 8; i++ {
		if err := curStore.AddItemTag(ctx, library[i].ID, b, ""); err != nil {
			t.Fatal(err)
		}
	}

	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/items?profileId=1&tagId="+strconv.FormatInt(a, 10), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("tag filter -> %d body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Items []struct {
			Id   string
			Tags []struct{ Name string }
		}
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Items) != 5 {
		t.Errorf("tag filter on Adventure should return 5 items, got %d", len(resp.Items))
	}
	for _, it := range resp.Items {
		if len(it.Tags) == 0 || it.Tags[0].Name != "Adventure" {
			t.Errorf("returned item missing Adventure tag decoration: %+v", it)
		}
	}
}

func TestAdminItemsBadTagIdRejected(t *testing.T) {
	srv, store := newTestServer(t, makeItems(1))
	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/items?profileId=1&tagId=abc", nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad tagId -> %d, want 400", rec.Code)
	}
}

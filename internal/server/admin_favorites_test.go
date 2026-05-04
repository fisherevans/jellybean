package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

func newKidForFavorites(t *testing.T, srv *Server, name, jellyfinUserID string) int64 {
	t.Helper()
	store := curation.NewStore(srv.db)
	kid, err := store.CreateKid(t.Context(), curation.CreateKidParams{
		Name:           name,
		ProfileID:      defaultProfileID(t, srv),
		JellyfinUserID: jellyfinUserID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return kid.ID
}

func TestAdminFavoritesAddListRemove(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "movie-1", Name: "Cars", Type: "Movie", ProductionYear: 2006},
		{ID: "movie-2", Name: "Up", Type: "Movie", ProductionYear: 2009},
	}
	srv, store := newTestServer(t, library)
	kidID := newKidForFavorites(t, srv, "Ollie", "user-ollie")

	// Add two favorites.
	for _, id := range []string{"movie-1", "movie-2"} {
		rec := authedRequest(t, srv, store, http.MethodPut,
			"/api/admin/kids/"+strconv.FormatInt(kidID, 10)+"/favorites/"+id, nil)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("add %s -> %d body %s", id, rec.Code, rec.Body.String())
		}
	}
	// Idempotent re-add.
	rec := authedRequest(t, srv, store, http.MethodPut,
		"/api/admin/kids/"+strconv.FormatInt(kidID, 10)+"/favorites/movie-1", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("idempotent add -> %d", rec.Code)
	}

	// List - should return 2 favorites with metadata.
	rec = authedRequest(t, srv, store, http.MethodGet,
		"/api/admin/kids/"+strconv.FormatInt(kidID, 10)+"/favorites", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list -> %d", rec.Code)
	}
	var listed struct {
		KidID     int64 `json:"kidId"`
		ProfileID int64 `json:"profileId"`
		Favorites []struct {
			ItemID  string `json:"itemId"`
			Name    string `json:"name"`
			Type    string `json:"type"`
			Visible bool   `json:"visible"`
		} `json:"favorites"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Favorites) != 2 {
		t.Fatalf("want 2 favorites, got %d", len(listed.Favorites))
	}
	for _, f := range listed.Favorites {
		if f.Name == "" || f.Type != "Movie" {
			t.Errorf("favorite missing item metadata: %+v", f)
		}
		if f.Visible {
			t.Errorf("with no categorization, %s should not be visible", f.ItemID)
		}
	}

	// Mark movie-1 visible for the profile and confirm Visible flips.
	curStore := curation.NewStore(srv.db)
	visible := curation.StateVisible
	if _, err := curStore.SetState(t.Context(), "movie-1", listed.ProfileID, &visible, "admin"); err != nil {
		t.Fatal(err)
	}
	rec = authedRequest(t, srv, store, http.MethodGet,
		"/api/admin/kids/"+strconv.FormatInt(kidID, 10)+"/favorites", nil)
	json.Unmarshal(rec.Body.Bytes(), &listed)
	for _, f := range listed.Favorites {
		if f.ItemID == "movie-1" && !f.Visible {
			t.Errorf("movie-1 should be visible after categorization")
		}
		if f.ItemID == "movie-2" && f.Visible {
			t.Errorf("movie-2 should still be hidden")
		}
	}

	// Remove.
	rec = authedRequest(t, srv, store, http.MethodDelete,
		"/api/admin/kids/"+strconv.FormatInt(kidID, 10)+"/favorites/movie-1", nil)
	if rec.Code != http.StatusNoContent {
		t.Errorf("delete -> %d", rec.Code)
	}
	// Removing a non-favorite is a no-op.
	rec = authedRequest(t, srv, store, http.MethodDelete,
		"/api/admin/kids/"+strconv.FormatInt(kidID, 10)+"/favorites/never-added", nil)
	if rec.Code != http.StatusNoContent {
		t.Errorf("idempotent delete -> %d", rec.Code)
	}
}

func TestAdminFavoritesUnknownKid(t *testing.T) {
	srv, store := newTestServer(t, nil)
	rec := authedRequest(t, srv, store, http.MethodGet, "/api/admin/kids/9999/favorites", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown kid -> %d, want 404", rec.Code)
	}
	rec = authedRequest(t, srv, store, http.MethodPut, "/api/admin/kids/9999/favorites/abc", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("PUT unknown kid -> %d, want 404", rec.Code)
	}
}

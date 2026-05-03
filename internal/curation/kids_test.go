package curation

import (
	"context"
	"errors"
	"testing"

	"github.com/fisherevans/jellybean/internal/db"
)

func openStoreWithProfile(t *testing.T) (*Store, int64) {
	t.Helper()
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	store := NewStore(conn)
	// Default profile from the migration.
	row := conn.QueryRow(`SELECT id FROM profiles WHERE name = 'Default'`)
	var id int64
	if err := row.Scan(&id); err != nil {
		t.Fatal(err)
	}
	return store, id
}

func TestCreateKidAndLookup(t *testing.T) {
	store, profileID := openStoreWithProfile(t)
	ctx := context.Background()

	res, err := store.CreateKid(ctx, CreateKidParams{
		Name:           "alice",
		ProfileID:      profileID,
		JellyfinUserID: "jf-alice",
		JellyfinToken:  "jellyfin-token-1",
	})
	if err != nil {
		t.Fatalf("CreateKid: %v", err)
	}
	if res.RawAPIKey == "" || len(res.RawAPIKey) != 64 {
		t.Errorf("RawAPIKey looks wrong: %q", res.RawAPIKey)
	}
	if res.Kid.HasToken != true {
		t.Errorf("HasToken should be true after creation with a token")
	}
	if res.Kid.ProfileName != "Default" {
		t.Errorf("ProfileName = %q, want Default", res.Kid.ProfileName)
	}

	// Lookup by raw key returns the same row + the token.
	entry, err := store.FindKidByAPIKey(ctx, res.RawAPIKey)
	if err != nil {
		t.Fatalf("FindKidByAPIKey: %v", err)
	}
	if entry.JellyfinUserID != "jf-alice" || entry.JellyfinToken != "jellyfin-token-1" {
		t.Errorf("entry = %+v", entry)
	}
}

func TestCreateKidRejectsDuplicateJellyfinUser(t *testing.T) {
	store, profileID := openStoreWithProfile(t)
	ctx := context.Background()

	_, err := store.CreateKid(ctx, CreateKidParams{
		Name: "alice", ProfileID: profileID, JellyfinUserID: "jf-1", JellyfinToken: "tok",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.CreateKid(ctx, CreateKidParams{
		Name: "alice2", ProfileID: profileID, JellyfinUserID: "jf-1", JellyfinToken: "tok2",
	})
	if !errors.Is(err, ErrKidUserCollision) {
		t.Errorf("expected ErrKidUserCollision, got %v", err)
	}
}

func TestFindKidByAPIKeyMissReturnsNotFound(t *testing.T) {
	store, _ := openStoreWithProfile(t)
	_, err := store.FindKidByAPIKey(context.Background(), "definitely-not-a-real-key")
	if !errors.Is(err, ErrKidNotFound) {
		t.Errorf("expected ErrKidNotFound, got %v", err)
	}
}

func TestRegenerateAPIKeyInvalidatesOldKey(t *testing.T) {
	store, profileID := openStoreWithProfile(t)
	ctx := context.Background()
	res, _ := store.CreateKid(ctx, CreateKidParams{
		Name: "alice", ProfileID: profileID, JellyfinUserID: "jf-1", JellyfinToken: "tok",
	})
	oldKey := res.RawAPIKey

	newKey, err := store.RegenerateAPIKey(ctx, res.Kid.ID)
	if err != nil {
		t.Fatal(err)
	}
	if newKey == oldKey {
		t.Error("regenerate returned the same key")
	}
	if _, err := store.FindKidByAPIKey(ctx, oldKey); !errors.Is(err, ErrKidNotFound) {
		t.Errorf("old key should no longer authenticate, got %v", err)
	}
	if _, err := store.FindKidByAPIKey(ctx, newKey); err != nil {
		t.Errorf("new key should authenticate, got %v", err)
	}
}

func TestDeleteKid(t *testing.T) {
	store, profileID := openStoreWithProfile(t)
	ctx := context.Background()
	res, _ := store.CreateKid(ctx, CreateKidParams{
		Name: "alice", ProfileID: profileID, JellyfinUserID: "jf-1", JellyfinToken: "tok",
	})
	if err := store.DeleteKid(ctx, res.Kid.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteKid(ctx, res.Kid.ID); !errors.Is(err, ErrKidNotFound) {
		t.Errorf("second delete should return ErrKidNotFound, got %v", err)
	}
}

func TestProfileCRUD(t *testing.T) {
	store, defaultID := openStoreWithProfile(t)
	ctx := context.Background()

	created, err := store.CreateProfile(ctx, ProfileInput{
		Name:        "Young kids",
		Description: "G and TV-Y only",
		MinAge:      2,
		MaxAge:      7,
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Name != "Young kids" {
		t.Errorf("name = %q", created.Name)
	}
	if created.MinAge != 2 || created.MaxAge != 7 {
		t.Errorf("range = %d..%d, want 2..7", created.MinAge, created.MaxAge)
	}

	all, err := store.ListProfiles(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Errorf("ListProfiles len = %d, want 2", len(all))
	}

	updated, err := store.UpdateProfile(ctx, created.ID, ProfileInput{
		Name:        "Young kids ",
		Description: "edited description",
		MinAge:      3,
		MaxAge:      8,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Description != "edited description" {
		t.Errorf("description = %q", updated.Description)
	}
	if updated.Name != "Young kids" {
		t.Errorf("name should be trimmed: %q", updated.Name)
	}

	if err := store.DeleteProfile(ctx, defaultID); !errors.Is(err, ErrProfileProtected) {
		t.Errorf("default delete should be protected, got %v", err)
	}

	// Profile in use rejects delete.
	_, _ = store.CreateKid(ctx, CreateKidParams{
		Name: "alice", ProfileID: created.ID, JellyfinUserID: "jf-1", JellyfinToken: "tok",
	})
	if err := store.DeleteProfile(ctx, created.ID); !errors.Is(err, ErrProfileInUse) {
		t.Errorf("in-use delete should fail with ErrProfileInUse, got %v", err)
	}
}

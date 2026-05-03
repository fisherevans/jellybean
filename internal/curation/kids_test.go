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

	kid, err := store.CreateKid(ctx, CreateKidParams{
		Name:           "alice",
		ProfileID:      profileID,
		JellyfinUserID: "jf-alice",
	})
	if err != nil {
		t.Fatalf("CreateKid: %v", err)
	}
	if kid.Name != "alice" {
		t.Errorf("Name = %q, want alice", kid.Name)
	}
	if kid.ProfileName != "Default" {
		t.Errorf("ProfileName = %q, want Default", kid.ProfileName)
	}

	found, err := store.FindKidByJellyfinUser(ctx, "jf-alice")
	if err != nil {
		t.Fatalf("FindKidByJellyfinUser: %v", err)
	}
	if found.ID != kid.ID || found.ProfileID != profileID {
		t.Errorf("found = %+v", found)
	}
}

func TestCreateKidRejectsDuplicateJellyfinUser(t *testing.T) {
	store, profileID := openStoreWithProfile(t)
	ctx := context.Background()

	_, err := store.CreateKid(ctx, CreateKidParams{
		Name: "alice", ProfileID: profileID, JellyfinUserID: "jf-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.CreateKid(ctx, CreateKidParams{
		Name: "alice2", ProfileID: profileID, JellyfinUserID: "jf-1",
	})
	if !errors.Is(err, ErrKidUserCollision) {
		t.Errorf("expected ErrKidUserCollision, got %v", err)
	}
}

func TestFindKidByJellyfinUserMissReturnsNotFound(t *testing.T) {
	store, _ := openStoreWithProfile(t)
	_, err := store.FindKidByJellyfinUser(context.Background(), "no-such-user")
	if !errors.Is(err, ErrKidNotFound) {
		t.Errorf("expected ErrKidNotFound, got %v", err)
	}
}

func TestUpdateKid(t *testing.T) {
	store, profileID := openStoreWithProfile(t)
	ctx := context.Background()
	kid, _ := store.CreateKid(ctx, CreateKidParams{
		Name: "alice", ProfileID: profileID, JellyfinUserID: "jf-1",
	})
	if err := store.UpdateKid(ctx, kid.ID, "Alice (renamed)", 0); err != nil {
		t.Fatal(err)
	}
	got, _ := store.GetKid(ctx, kid.ID)
	if got.Name != "Alice (renamed)" {
		t.Errorf("name = %q", got.Name)
	}
}

func TestDeleteKid(t *testing.T) {
	store, profileID := openStoreWithProfile(t)
	ctx := context.Background()
	kid, _ := store.CreateKid(ctx, CreateKidParams{
		Name: "alice", ProfileID: profileID, JellyfinUserID: "jf-1",
	})
	if err := store.DeleteKid(ctx, kid.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteKid(ctx, kid.ID); !errors.Is(err, ErrKidNotFound) {
		t.Errorf("second delete should return ErrKidNotFound, got %v", err)
	}
}

func TestProfileCRUD(t *testing.T) {
	store, defaultID := openStoreWithProfile(t)
	ctx := context.Background()

	created, err := store.CreateProfile(ctx, ProfileInput{
		Name:        "Young kids",
		Description: "G and TV-Y only",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Name != "Young kids" {
		t.Errorf("name = %q", created.Name)
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

	_, _ = store.CreateKid(ctx, CreateKidParams{
		Name: "alice", ProfileID: created.ID, JellyfinUserID: "jf-1",
	})
	if err := store.DeleteProfile(ctx, created.ID); !errors.Is(err, ErrProfileInUse) {
		t.Errorf("in-use delete should fail with ErrProfileInUse, got %v", err)
	}
}

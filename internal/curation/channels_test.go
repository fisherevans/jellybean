package curation

import (
	"context"
	"testing"
)

func TestChannelCreateAndList(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()
	ch, err := store.CreateChannel(ctx, Channel{
		ProfileID: profileID,
		Name:      "Bluey TV",
		SortOrder: "random",
		ItemIDs:   []string{"item-a", "item-b"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ch.ID == 0 {
		t.Error("ID = 0 after Create")
	}
	if len(ch.ItemIDs) != 2 {
		t.Errorf("ItemIDs = %v, want 2", ch.ItemIDs)
	}
	list, _ := store.ListChannels(ctx, profileID)
	if len(list) != 1 {
		t.Errorf("ListChannels returned %d, want 1", len(list))
	}
}

func TestChannelUpdateReplacesItems(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()
	ch, _ := store.CreateChannel(ctx, Channel{
		ProfileID: profileID, Name: "C", SortOrder: "in_order",
		ItemIDs: []string{"a", "b"},
	})
	updated, err := store.UpdateChannel(ctx, ch.ID, Channel{
		Name: "C2", SortOrder: "random", ItemIDs: []string{"x"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "C2" || updated.SortOrder != "random" {
		t.Errorf("got %+v", updated)
	}
	if len(updated.ItemIDs) != 1 || updated.ItemIDs[0] != "x" {
		t.Errorf("ItemIDs = %v, want [x]", updated.ItemIDs)
	}
}

func TestChannelDelete(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()
	ch, _ := store.CreateChannel(ctx, Channel{
		ProfileID: profileID, Name: "Goner", SortOrder: "random",
	})
	if err := store.DeleteChannel(ctx, ch.ID); err != nil {
		t.Fatal(err)
	}
	list, _ := store.ListChannels(ctx, profileID)
	if len(list) != 0 {
		t.Errorf("ListChannels returned %d after delete, want 0", len(list))
	}
}

func TestChannelInvalidSortOrder(t *testing.T) {
	_, store, profileID := openStore(t)
	_, err := store.CreateChannel(context.Background(), Channel{
		ProfileID: profileID, Name: "Bad", SortOrder: "fast-and-loose",
	})
	if err == nil {
		t.Error("expected validation error")
	}
}

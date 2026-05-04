package curation

import (
	"context"
	"errors"
	"testing"
)

// makeTag is a small helper for the tests.
func makeTag(t *testing.T, store *Store, name string) *Tag {
	t.Helper()
	tag, err := store.CreateTag(context.Background(), TagInput{Name: name})
	if err != nil {
		t.Fatalf("CreateTag(%q): %v", name, err)
	}
	return tag
}

func TestTagCRUDAndUniqueName(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()

	created, err := store.CreateTag(ctx, TagInput{
		Name:        "Adventure",
		Description: "Big-feel stories",
		SortOrder:   10,
	})
	if err != nil {
		t.Fatalf("CreateTag: %v", err)
	}
	if created.Name != "Adventure" || created.Description != "Big-feel stories" || created.SortOrder != 10 {
		t.Errorf("created tag fields wrong: %+v", created)
	}

	// Same name -> ErrTagNameTaken.
	if _, err := store.CreateTag(ctx, TagInput{Name: "Adventure"}); !errors.Is(err, ErrTagNameTaken) {
		t.Errorf("want ErrTagNameTaken, got %v", err)
	}

	// Update.
	updated, err := store.UpdateTag(ctx, created.ID, TagInput{
		Name:        "Adventures",
		Description: "renamed",
		SortOrder:   5,
	})
	if err != nil {
		t.Fatalf("UpdateTag: %v", err)
	}
	if updated.Name != "Adventures" || updated.SortOrder != 5 {
		t.Errorf("update did not stick: %+v", updated)
	}

	// Delete.
	if err := store.DeleteTag(ctx, created.ID); err != nil {
		t.Fatalf("DeleteTag: %v", err)
	}
	if _, err := store.GetTag(ctx, created.ID); !errors.Is(err, ErrTagNotFound) {
		t.Errorf("want ErrTagNotFound, got %v", err)
	}
}

func TestListTagsSorting(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()

	a := makeTag(t, store, "Bedtime")
	b := makeTag(t, store, "Adventure")
	c := makeTag(t, store, "Comedy")

	// Apply two items to "Adventure" so its count is highest.
	if err := store.AddItemTag(ctx, "item-1", b.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := store.AddItemTag(ctx, "item-2", b.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := store.AddItemTag(ctx, "item-3", a.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	_ = c

	byName, err := store.ListTags(ctx, TagSortName)
	if err != nil {
		t.Fatal(err)
	}
	if len(byName) != 3 || byName[0].Name != "Adventure" {
		t.Errorf("by-name first should be Adventure, got %+v", byName)
	}

	byCount, err := store.ListTags(ctx, TagSortCount)
	if err != nil {
		t.Fatal(err)
	}
	if byCount[0].Name != "Adventure" || byCount[0].ItemCount != 2 {
		t.Errorf("by-count first should be Adventure (2 items), got %+v", byCount[0])
	}
}

func TestSetTagsForItemReplacesSet(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()

	a := makeTag(t, store, "A")
	b := makeTag(t, store, "B")
	c := makeTag(t, store, "C")

	if err := store.SetTagsForItem(ctx, "item-x", []int64{a.ID, b.ID}, "alice"); err != nil {
		t.Fatal(err)
	}
	tags, _ := store.GetTagsForItem(ctx, "item-x")
	if len(tags) != 2 {
		t.Fatalf("want 2 tags, got %d", len(tags))
	}

	// Replace with {b, c}: a should be removed, c added.
	if err := store.SetTagsForItem(ctx, "item-x", []int64{b.ID, c.ID}, "alice"); err != nil {
		t.Fatal(err)
	}
	tags, _ = store.GetTagsForItem(ctx, "item-x")
	if len(tags) != 2 {
		t.Fatalf("want 2 tags after replace, got %d", len(tags))
	}
	names := map[string]bool{}
	for _, x := range tags {
		names[x.Name] = true
	}
	if names["A"] {
		t.Errorf("A should have been removed")
	}
	if !names["B"] || !names["C"] {
		t.Errorf("B and C should remain, got %+v", names)
	}
}

func TestGetTagsForItemsBatch(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()
	a := makeTag(t, store, "A")
	b := makeTag(t, store, "B")
	if err := store.AddItemTag(ctx, "i1", a.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.AddItemTag(ctx, "i1", b.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.AddItemTag(ctx, "i2", a.ID, ""); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetTagsForItems(ctx, []string{"i1", "i2", "i3"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got["i1"]) != 2 {
		t.Errorf("i1 should have 2 tags, got %d", len(got["i1"]))
	}
	if len(got["i2"]) != 1 {
		t.Errorf("i2 should have 1 tag, got %d", len(got["i2"]))
	}
	if _, ok := got["i3"]; ok {
		t.Errorf("i3 has no tags; should be absent from map, got %+v", got["i3"])
	}
}

func TestTagCascadeOnDelete(t *testing.T) {
	conn, store, profileID := openStore(t)
	ctx := context.Background()

	a := makeTag(t, store, "A")
	if err := store.AddItemTag(ctx, "item-1", a.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.SetProfileTagFilter(ctx, profileID, a.ID, FilterAlwaysHidden); err != nil {
		t.Fatal(err)
	}

	// Delete the tag - cascades should clear item_tags + profile_tag_filters.
	if err := store.DeleteTag(ctx, a.ID); err != nil {
		t.Fatal(err)
	}

	var n int
	if err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM item_tags WHERE tag_id = ?`, a.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("item_tags rows should cascade-delete, got %d", n)
	}
	if err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM profile_tag_filters WHERE tag_id = ?`, a.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("profile_tag_filters rows should cascade-delete, got %d", n)
	}
}

func TestProfileTagFilterCRUD(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()
	a := makeTag(t, store, "Scary")

	if err := store.SetProfileTagFilter(ctx, profileID, a.ID, FilterAlwaysHidden); err != nil {
		t.Fatal(err)
	}
	filters, _ := store.ListProfileTagFilters(ctx, profileID)
	if len(filters) != 1 || filters[0].Mode != FilterAlwaysHidden {
		t.Fatalf("want 1 filter always_hidden, got %+v", filters)
	}

	// Update via re-set with the other mode.
	if err := store.SetProfileTagFilter(ctx, profileID, a.ID, FilterAlwaysVisible); err != nil {
		t.Fatal(err)
	}
	filters, _ = store.ListProfileTagFilters(ctx, profileID)
	if len(filters) != 1 || filters[0].Mode != FilterAlwaysVisible {
		t.Fatalf("want 1 filter always_visible after update, got %+v", filters)
	}

	if err := store.ClearProfileTagFilter(ctx, profileID, a.ID); err != nil {
		t.Fatal(err)
	}
	filters, _ = store.ListProfileTagFilters(ctx, profileID)
	if len(filters) != 0 {
		t.Errorf("filter should be cleared, got %+v", filters)
	}
}

func TestEffectiveItemVisibilityResolution(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	scary := makeTag(t, store, "Scary")
	bedtime := makeTag(t, store, "Bedtime")

	// Item with no tags + no categorization -> hidden.
	v, err := store.EffectiveItemVisibility(ctx, profileID, "item-untagged")
	if err != nil || v != StateHidden {
		t.Errorf("untagged item should resolve hidden, got %q (err %v)", v, err)
	}

	// Item with no tags + visible categorization -> visible.
	visible := StateVisible
	if _, err := store.SetState(ctx, "item-cat-visible", profileID, &visible, "alice"); err != nil {
		t.Fatal(err)
	}
	v, err = store.EffectiveItemVisibility(ctx, profileID, "item-cat-visible")
	if err != nil || v != StateVisible {
		t.Errorf("untagged + visible cat should resolve visible, got %q (err %v)", v, err)
	}

	// Item with tag X but no filter on X -> falls back to categorization.
	hidden := StateHidden
	if _, err := store.SetState(ctx, "item-tagged-hidden", profileID, &hidden, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := store.AddItemTag(ctx, "item-tagged-hidden", bedtime.ID, ""); err != nil {
		t.Fatal(err)
	}
	v, _ = store.EffectiveItemVisibility(ctx, profileID, "item-tagged-hidden")
	if v != StateHidden {
		t.Errorf("tagged item without filter should fall back to categorization (hidden), got %q", v)
	}

	// Item with tag carrying always_visible -> visible regardless of categorization.
	if err := store.SetProfileTagFilter(ctx, profileID, bedtime.ID, FilterAlwaysVisible); err != nil {
		t.Fatal(err)
	}
	v, _ = store.EffectiveItemVisibility(ctx, profileID, "item-tagged-hidden")
	if v != StateVisible {
		t.Errorf("always_visible filter on Bedtime tag should override hidden categorization, got %q", v)
	}

	// Item with two tags, one always_visible, one always_hidden ->
	// always_hidden wins.
	if err := store.AddItemTag(ctx, "item-tagged-hidden", scary.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.SetProfileTagFilter(ctx, profileID, scary.ID, FilterAlwaysHidden); err != nil {
		t.Fatal(err)
	}
	v, _ = store.EffectiveItemVisibility(ctx, profileID, "item-tagged-hidden")
	if v != StateHidden {
		t.Errorf("always_hidden should win over always_visible, got %q", v)
	}
}

func TestEffectiveItemVisibilityBulkMatchesSingle(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	scary := makeTag(t, store, "Scary")
	bedtime := makeTag(t, store, "Bedtime")
	if err := store.SetProfileTagFilter(ctx, profileID, bedtime.ID, FilterAlwaysVisible); err != nil {
		t.Fatal(err)
	}
	if err := store.SetProfileTagFilter(ctx, profileID, scary.ID, FilterAlwaysHidden); err != nil {
		t.Fatal(err)
	}

	// item-A: bedtime tag only -> visible (filter wins).
	if err := store.AddItemTag(ctx, "item-A", bedtime.ID, ""); err != nil {
		t.Fatal(err)
	}
	// item-B: scary tag only -> hidden (filter wins).
	if err := store.AddItemTag(ctx, "item-B", scary.ID, ""); err != nil {
		t.Fatal(err)
	}
	// item-C: both tags -> hidden (always_hidden wins).
	if err := store.AddItemTag(ctx, "item-C", bedtime.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.AddItemTag(ctx, "item-C", scary.ID, ""); err != nil {
		t.Fatal(err)
	}
	// item-D: no tags, but visible categorization.
	visible := StateVisible
	if _, err := store.SetState(ctx, "item-D", profileID, &visible, "alice"); err != nil {
		t.Fatal(err)
	}
	// item-E: no rows anywhere -> hidden.

	ids := []string{"item-A", "item-B", "item-C", "item-D", "item-E"}
	bulk, err := store.EffectiveItemVisibilityBulk(ctx, profileID, ids)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		single, _ := store.EffectiveItemVisibility(ctx, profileID, id)
		if bulk[id] != single {
			t.Errorf("%s: bulk %q != single %q", id, bulk[id], single)
		}
	}
	if bulk["item-A"] != StateVisible {
		t.Errorf("item-A should be visible, got %q", bulk["item-A"])
	}
	if bulk["item-B"] != StateHidden {
		t.Errorf("item-B should be hidden, got %q", bulk["item-B"])
	}
	if bulk["item-C"] != StateHidden {
		t.Errorf("item-C (always_hidden wins) should be hidden, got %q", bulk["item-C"])
	}
	if bulk["item-D"] != StateVisible {
		t.Errorf("item-D should be visible (cat fallback), got %q", bulk["item-D"])
	}
	if bulk["item-E"] != StateHidden {
		t.Errorf("item-E should be hidden (no rows), got %q", bulk["item-E"])
	}
}

func TestKidFavorites(t *testing.T) {
	conn, store, profileID := openStore(t)
	ctx := context.Background()

	kid, err := store.CreateKid(ctx, CreateKidParams{
		Name:           "Ollie",
		ProfileID:      profileID,
		JellyfinUserID: "user-ollie",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Empty initially.
	favs, _ := store.ListKidFavorites(ctx, kid.ID)
	if len(favs) != 0 {
		t.Errorf("expected empty favorites, got %+v", favs)
	}

	// Add + idempotent.
	if err := store.AddKidFavorite(ctx, kid.ID, "movie-1"); err != nil {
		t.Fatal(err)
	}
	if err := store.AddKidFavorite(ctx, kid.ID, "movie-1"); err != nil {
		t.Fatalf("repeat add should be idempotent: %v", err)
	}
	favs, _ = store.ListKidFavorites(ctx, kid.ID)
	if len(favs) != 1 {
		t.Fatalf("want 1 favorite, got %d", len(favs))
	}

	// IsKidFavorite.
	is, _ := store.IsKidFavorite(ctx, kid.ID, "movie-1")
	if !is {
		t.Errorf("movie-1 should be favorited")
	}
	is, _ = store.IsKidFavorite(ctx, kid.ID, "movie-2")
	if is {
		t.Errorf("movie-2 should not be favorited")
	}

	// Remove.
	if err := store.RemoveKidFavorite(ctx, kid.ID, "movie-1"); err != nil {
		t.Fatal(err)
	}
	favs, _ = store.ListKidFavorites(ctx, kid.ID)
	if len(favs) != 0 {
		t.Errorf("favorites should be empty after remove, got %+v", favs)
	}

	// Cascade on kid delete.
	if err := store.AddKidFavorite(ctx, kid.ID, "movie-3"); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteKid(ctx, kid.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM kid_favorites WHERE kid_id = ?`, kid.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("kid_favorites should cascade-delete on kid delete, got %d rows", n)
	}
}

func TestProfileTagFilterCascadeOnProfileDelete(t *testing.T) {
	conn, store, _ := openStore(t)
	ctx := context.Background()

	prof, err := store.CreateProfile(ctx, ProfileInput{Name: "Toddler"})
	if err != nil {
		t.Fatal(err)
	}
	a := makeTag(t, store, "Scary")
	if err := store.SetProfileTagFilter(ctx, prof.ID, a.ID, FilterAlwaysHidden); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteProfile(ctx, prof.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM profile_tag_filters WHERE profile_id = ?`, prof.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("profile_tag_filters should cascade-delete on profile delete, got %d rows", n)
	}
}

func TestParseProfileFilterMode(t *testing.T) {
	tests := []struct {
		in      string
		want    ProfileFilterMode
		wantErr bool
	}{
		{"always_visible", FilterAlwaysVisible, false},
		{"always_hidden", FilterAlwaysHidden, false},
		{"", "", true},
		{"bogus", "", true},
		{"ALWAYS_VISIBLE", "", true}, // case-sensitive
	}
	for _, tt := range tests {
		got, err := ParseProfileFilterMode(tt.in)
		if (err != nil) != tt.wantErr {
			t.Errorf("ParseProfileFilterMode(%q) err = %v, wantErr %v", tt.in, err, tt.wantErr)
		}
		if got != tt.want {
			t.Errorf("ParseProfileFilterMode(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

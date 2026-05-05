package curation

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSeededDefaultLayout(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()

	def, err := store.GetDefaultLayout(ctx)
	if err != nil {
		t.Fatalf("GetDefaultLayout: %v", err)
	}
	if def.Name != "Default" {
		t.Errorf("default layout name = %q, want Default", def.Name)
	}
	rows, err := store.ListLayoutRows(ctx, def.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantTypes := []RowType{
		RowContinueWatching,
		RowFavorites,
		RowTagFanout,
		RowRecentlyAdded,
		RowRandomUnwatched,
	}
	if len(rows) != len(wantTypes) {
		t.Fatalf("seeded rows: want %d, got %d (%+v)", len(wantTypes), len(rows), rows)
	}
	for i, want := range wantTypes {
		if rows[i].Type != want {
			t.Errorf("row %d: want %q, got %q", i, want, rows[i].Type)
		}
		if rows[i].Position != i {
			t.Errorf("row %d: position = %d, want %d", i, rows[i].Position, i)
		}
	}
}

func TestProfileLayoutBackfill(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	// The migration sets every existing profile's layout_id to the
	// default. Confirm that worked for the Default profile.
	def, err := store.GetDefaultLayout(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var assigned int64
	if err := store.db.QueryRowContext(ctx, `SELECT layout_id FROM profiles WHERE id = ?`, profileID).Scan(&assigned); err != nil {
		t.Fatal(err)
	}
	if assigned != def.ID {
		t.Errorf("default profile should be assigned to default layout, got layout_id=%d", assigned)
	}
}

func TestLayoutCRUDAndUniqueName(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()

	created, err := store.CreateLayout(ctx, LayoutInput{Name: "Bedtime", Description: "for night"})
	if err != nil {
		t.Fatal(err)
	}
	if created.IsDefault {
		t.Error("new layout should not be default")
	}

	// Duplicate name -> ErrLayoutNameTaken.
	if _, err := store.CreateLayout(ctx, LayoutInput{Name: "Bedtime"}); !errors.Is(err, ErrLayoutNameTaken) {
		t.Errorf("dup name -> %v, want ErrLayoutNameTaken", err)
	}

	// Update name.
	updated, err := store.UpdateLayout(ctx, created.ID, LayoutInput{Name: "Night", Description: "renamed"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Night" {
		t.Errorf("name not updated: %+v", updated)
	}

	// Delete the non-default layout.
	if err := store.DeleteLayout(ctx, updated.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetLayout(ctx, updated.ID); !errors.Is(err, ErrLayoutNotFound) {
		t.Errorf("get after delete: %v", err)
	}
}

func TestDeleteDefaultLayoutBlocked(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()
	def, _ := store.GetDefaultLayout(ctx)
	if err := store.DeleteLayout(ctx, def.ID); !errors.Is(err, ErrLayoutProtected) {
		t.Errorf("delete default -> %v, want ErrLayoutProtected", err)
	}
}

func TestSetDefaultLayout(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()
	other, err := store.CreateLayout(ctx, LayoutInput{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetDefaultLayout(ctx, other.ID); err != nil {
		t.Fatal(err)
	}
	def, _ := store.GetDefaultLayout(ctx)
	if def.Name != "Other" {
		t.Errorf("default switched to %q, want Other", def.Name)
	}
	// Exactly one row should still be is_default=1.
	all, _ := store.ListLayouts(ctx)
	count := 0
	for _, l := range all {
		if l.IsDefault {
			count++
		}
	}
	if count != 1 {
		t.Errorf("want 1 default after switch, got %d", count)
	}
}

func TestLayoutRowAppendAndReorder(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()
	l, _ := store.CreateLayout(ctx, LayoutInput{Name: "L"})

	a, err := store.AppendRow(ctx, l.ID, LayoutRowInput{
		Type:       RowContinueWatching,
		ConfigJSON: `{"max_items":10}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	b, err := store.AppendRow(ctx, l.ID, LayoutRowInput{
		Type:       RowFavorites,
		ConfigJSON: `{"max_items":15}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	c, err := store.AppendRow(ctx, l.ID, LayoutRowInput{
		Type:       RowRecentlyAdded,
		ConfigJSON: `{"max_items":20}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if a.Position != 0 || b.Position != 1 || c.Position != 2 {
		t.Errorf("positions wrong: %d %d %d", a.Position, b.Position, c.Position)
	}

	// Reorder to c, a, b.
	if err := store.ReorderRows(ctx, l.ID, []int64{c.ID, a.ID, b.ID}); err != nil {
		t.Fatal(err)
	}
	rs, _ := store.ListLayoutRows(ctx, l.ID)
	if len(rs) != 3 || rs[0].ID != c.ID || rs[1].ID != a.ID || rs[2].ID != b.ID {
		t.Errorf("reorder wrong: %+v", rs)
	}

	// Delete middle row -> positions reflow.
	if err := store.DeleteRow(ctx, rs[1].ID); err != nil {
		t.Fatal(err)
	}
	rs, _ = store.ListLayoutRows(ctx, l.ID)
	if len(rs) != 2 || rs[0].Position != 0 || rs[1].Position != 1 {
		t.Errorf("position reflow wrong: %+v", rs)
	}
}

func TestLayoutCloneCopiesRows(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()
	src, _ := store.CreateLayout(ctx, LayoutInput{Name: "Source"})
	store.AppendRow(ctx, src.ID, LayoutRowInput{Type: RowContinueWatching})
	store.AppendRow(ctx, src.ID, LayoutRowInput{Type: RowFavorites})

	dst, err := store.CloneLayout(ctx, src.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if dst.Name != "Source (copy)" {
		t.Errorf("clone name = %q", dst.Name)
	}
	rs, _ := store.ListLayoutRows(ctx, dst.ID)
	if len(rs) != 2 {
		t.Fatalf("clone rows wrong: %+v", rs)
	}
	if rs[0].Type != RowContinueWatching || rs[1].Type != RowFavorites {
		t.Errorf("clone preserved order: %+v", rs)
	}
}

func TestLayoutCacheTTL(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()
	l, _ := store.CreateLayout(ctx, LayoutInput{Name: "L"})
	r, _ := store.AppendRow(ctx, l.ID, LayoutRowInput{Type: RowRandomUnwatched})

	// Empty cache.
	got, err := store.GetCachedRowOrder(ctx, profileID, l.ID, r.ID, 60*time.Minute)
	if err != nil || got != nil {
		t.Fatalf("expected empty cache, got %v err %v", got, err)
	}

	// Write + read fresh.
	if err := store.SetCachedRowOrder(ctx, profileID, l.ID, r.ID, `["a","b"]`); err != nil {
		t.Fatal(err)
	}
	got, _ = store.GetCachedRowOrder(ctx, profileID, l.ID, r.ID, 60*time.Minute)
	if got == nil || got.ItemIDsJSON != `["a","b"]` {
		t.Errorf("cache miss after write: %+v", got)
	}

	// TTL=0 should expire it.
	got, _ = store.GetCachedRowOrder(ctx, profileID, l.ID, r.ID, 0)
	if got != nil {
		t.Errorf("expired cache returned non-nil: %+v", got)
	}

	// InvalidateProfileLayoutCache nukes it.
	if err := store.InvalidateProfileLayoutCache(ctx, profileID); err != nil {
		t.Fatal(err)
	}
	got, _ = store.GetCachedRowOrder(ctx, profileID, l.ID, r.ID, 60*time.Minute)
	if got != nil {
		t.Errorf("invalidate left rows: %+v", got)
	}
}

func TestRowMutationInvalidatesCache(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()
	l, _ := store.CreateLayout(ctx, LayoutInput{Name: "L"})
	r, _ := store.AppendRow(ctx, l.ID, LayoutRowInput{Type: RowRandomUnwatched})
	store.SetCachedRowOrder(ctx, profileID, l.ID, r.ID, `["x"]`)

	// Updating the row should clear cache for the layout.
	if _, err := store.UpdateRow(ctx, r.ID, LayoutRowInput{
		Type:       RowRandomUnwatched,
		ConfigJSON: `{"max_items":50}`,
	}); err != nil {
		t.Fatal(err)
	}
	got, _ := store.GetCachedRowOrder(ctx, profileID, l.ID, r.ID, 60*time.Minute)
	if got != nil {
		t.Errorf("cache should be cleared after row update, got %+v", got)
	}
}

func TestSetProfileLayoutClearsCache(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()
	l, _ := store.CreateLayout(ctx, LayoutInput{Name: "L"})
	r, _ := store.AppendRow(ctx, l.ID, LayoutRowInput{Type: RowRandomUnwatched})
	store.SetCachedRowOrder(ctx, profileID, l.ID, r.ID, `["x"]`)

	if err := store.SetProfileLayout(ctx, profileID, l.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := store.GetCachedRowOrder(ctx, profileID, l.ID, r.ID, 60*time.Minute)
	if got != nil {
		t.Errorf("profile-layout switch should clear cache, got %+v", got)
	}
}

func TestParseRowType(t *testing.T) {
	for _, rt := range AllRowTypes {
		if _, err := ParseRowType(string(rt)); err != nil {
			t.Errorf("%s should parse, got %v", rt, err)
		}
	}
	if _, err := ParseRowType("bogus"); err == nil {
		t.Errorf("bogus should fail")
	}
}

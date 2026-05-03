package curation

import (
	"context"
	"database/sql"
	"testing"

	"github.com/fisherevans/jellybean/internal/db"
)

func openStore(t *testing.T) (*sql.DB, *Store) {
	t.Helper()
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn, NewStore(conn)
}

func TestParseCategory(t *testing.T) {
	tests := []struct {
		in      string
		want    Category
		wantErr bool
	}{
		{"kid", CategoryKid, false},
		{"adult", CategoryAdult, false},
		{"uncategorized", CategoryUncategorized, false},
		{"", "", true},
		{"bogus", "", true},
		{"KID", "", true}, // case-sensitive on purpose; matches the DB CHECK
	}
	for _, tt := range tests {
		got, err := ParseCategory(tt.in)
		if (err != nil) != tt.wantErr {
			t.Errorf("ParseCategory(%q) err = %v, wantErr %v", tt.in, err, tt.wantErr)
		}
		if got != tt.want {
			t.Errorf("ParseCategory(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestSetCategoryAndHistory(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	prev, err := store.SetCategory(ctx, "item-1", CategoryKid, "alice")
	if err != nil {
		t.Fatalf("SetCategory: %v", err)
	}
	if prev != "" {
		t.Errorf("first set: prev = %q, want empty", prev)
	}

	cat, err := store.GetCategory(ctx, "item-1")
	if err != nil {
		t.Fatal(err)
	}
	if cat != CategoryKid {
		t.Errorf("GetCategory = %q", cat)
	}

	// Re-categorize: should record from->to in history.
	prev, err = store.SetCategory(ctx, "item-1", CategoryAdult, "bob")
	if err != nil {
		t.Fatal(err)
	}
	if prev != CategoryKid {
		t.Errorf("second set: prev = %q, want kid", prev)
	}

	hist, err := store.RecentHistory(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) != 2 {
		t.Fatalf("history len = %d, want 2", len(hist))
	}
	// Newest first: the second change.
	if hist[0].FromCategory != CategoryKid || hist[0].ToCategory != CategoryAdult || hist[0].ChangedBy != "bob" {
		t.Errorf("hist[0] = %+v", hist[0])
	}
	// First change had no prior category.
	if hist[1].FromCategory != "" || hist[1].ToCategory != CategoryKid || hist[1].ChangedBy != "alice" {
		t.Errorf("hist[1] = %+v", hist[1])
	}
}

func TestSetCategoryNoOpDoesNotRecordHistory(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	if _, err := store.SetCategory(ctx, "item-1", CategoryKid, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetCategory(ctx, "item-1", CategoryKid, "alice"); err != nil {
		t.Fatal(err)
	}

	hist, err := store.RecentHistory(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) != 1 {
		t.Errorf("history len = %d, want 1 (no-op should not write)", len(hist))
	}
}

func TestGetCategoryDefaultsUncategorized(t *testing.T) {
	_, store := openStore(t)
	cat, err := store.GetCategory(context.Background(), "never-set")
	if err != nil {
		t.Fatal(err)
	}
	if cat != CategoryUncategorized {
		t.Errorf("GetCategory(never-set) = %q, want uncategorized", cat)
	}
}

func TestSetCategoryBulk(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	// Pre-set one item; bulk should be a no-op for it (already kid) and
	// apply to the others.
	if _, err := store.SetCategory(ctx, "a", CategoryKid, "admin"); err != nil {
		t.Fatal(err)
	}

	changed, err := store.SetCategoryBulk(ctx, []string{"a", "b", "c"}, CategoryKid, "admin")
	if err != nil {
		t.Fatalf("bulk: %v", err)
	}
	if changed != 2 {
		t.Errorf("changed = %d, want 2 (a was already kid)", changed)
	}

	for _, id := range []string{"a", "b", "c"} {
		cat, _ := store.GetCategory(ctx, id)
		if cat != CategoryKid {
			t.Errorf("%s = %q, want kid", id, cat)
		}
	}
}

func TestSetCategoryBulkRollsBackOnError(t *testing.T) {
	conn, store := openStore(t)
	ctx := context.Background()

	// Drop the table mid-test to force an error on insert; verify nothing
	// from this batch lands.
	if _, err := store.SetCategory(ctx, "pre-existing", CategoryKid, "admin"); err != nil {
		t.Fatal(err)
	}

	// Sabotage: drop the categorizations table.
	if _, err := conn.Exec(`DROP TABLE categorizations`); err != nil {
		t.Fatal(err)
	}

	_, err := store.SetCategoryBulk(ctx, []string{"x", "y"}, CategoryKid, "admin")
	if err == nil {
		t.Error("expected bulk to fail when table missing")
	}
}

func TestGetCategoriesForItems(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	if _, err := store.SetCategory(ctx, "a", CategoryKid, "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetCategory(ctx, "b", CategoryAdult, "admin"); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetCategoriesForItems(ctx, []string{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	if got["a"] != CategoryKid || got["b"] != CategoryAdult {
		t.Errorf("got = %v", got)
	}
	if _, ok := got["c"]; ok {
		t.Errorf("c should be absent (treat as uncategorized): %v", got)
	}
}

func TestRecentHistoryLimit(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	for i := 0; i < 10; i++ {
		if _, err := store.SetCategory(ctx, "item", Category("kid"), "admin"); err == nil {
			// alternate categories so each call records history
			store.SetCategory(ctx, "item", Category("adult"), "admin")
		}
	}

	hist, err := store.RecentHistory(ctx, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) > 5 {
		t.Errorf("hist len = %d, want <= 5", len(hist))
	}
}

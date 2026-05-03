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

func ageOf(n int) *int { return &n }

func TestParseBucket(t *testing.T) {
	tests := []struct {
		in      string
		want    AgeBucket
		wantErr bool
	}{
		{"kid", BucketKid, false},
		{"adult", BucketAdult, false},
		{"uncategorized", BucketUncategorized, false},
		{"", "", true},
		{"bogus", "", true},
		{"KID", "", true},
	}
	for _, tt := range tests {
		got, err := ParseBucket(tt.in)
		if (err != nil) != tt.wantErr {
			t.Errorf("ParseBucket(%q) err = %v, wantErr %v", tt.in, err, tt.wantErr)
		}
		if got != tt.want {
			t.Errorf("ParseBucket(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestAgeToBucket(t *testing.T) {
	tests := []struct {
		age  *int
		want AgeBucket
	}{
		{nil, BucketUncategorized},
		{ageOf(2), BucketKid},
		{ageOf(7), BucketKid},
		{ageOf(12), BucketKid},
		{ageOf(13), BucketAdult},
		{ageOf(18), BucketAdult},
	}
	for _, tt := range tests {
		got := AgeToBucket(tt.age)
		if got != tt.want {
			t.Errorf("AgeToBucket(%v) = %q, want %q", tt.age, got, tt.want)
		}
	}
}

func TestSetAgeAndHistory(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	prev, err := store.SetAge(ctx, "item-1", ageOf(7), "alice")
	if err != nil {
		t.Fatalf("SetAge: %v", err)
	}
	if prev != nil {
		t.Errorf("first set: prev = %v, want nil", prev)
	}

	cur, err := store.GetAge(ctx, "item-1")
	if err != nil {
		t.Fatal(err)
	}
	if cur == nil || *cur != AgeKid {
		t.Errorf("GetAge = %v", cur)
	}

	// Re-categorize: should record from->to in history.
	prev, err = store.SetAge(ctx, "item-1", ageOf(18), "bob")
	if err != nil {
		t.Fatal(err)
	}
	if prev == nil || *prev != AgeKid {
		t.Errorf("second set: prev = %v, want 7", prev)
	}

	hist, err := store.RecentHistory(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) != 2 {
		t.Fatalf("history len = %d, want 2", len(hist))
	}
	if hist[0].FromAge == nil || *hist[0].FromAge != AgeKid ||
		hist[0].ToAge == nil || *hist[0].ToAge != AgeAdult ||
		hist[0].ChangedBy != "bob" {
		t.Errorf("hist[0] = %+v", hist[0])
	}
	if hist[1].FromAge != nil || hist[1].ToAge == nil || *hist[1].ToAge != AgeKid {
		t.Errorf("hist[1] = %+v", hist[1])
	}
}

func TestSetAgeNoOpDoesNotRecordHistory(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	if _, err := store.SetAge(ctx, "item-1", ageOf(AgeKid), "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetAge(ctx, "item-1", ageOf(AgeKid), "alice"); err != nil {
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

func TestSetAgeNilUncategorizesAndRecordsHistory(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	if _, err := store.SetAge(ctx, "item-1", ageOf(AgeKid), "alice"); err != nil {
		t.Fatal(err)
	}
	prev, err := store.SetAge(ctx, "item-1", nil, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if prev == nil || *prev != AgeKid {
		t.Errorf("prev = %v, want 7", prev)
	}
	cur, _ := store.GetAge(ctx, "item-1")
	if cur != nil {
		t.Errorf("GetAge after nil set = %v, want nil", cur)
	}
}

func TestGetAgeDefaultsNil(t *testing.T) {
	_, store := openStore(t)
	got, err := store.GetAge(context.Background(), "never-set")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Errorf("GetAge(never-set) = %v, want nil", got)
	}
}

func TestSetAgeBulk(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	if _, err := store.SetAge(ctx, "a", ageOf(AgeKid), "admin"); err != nil {
		t.Fatal(err)
	}

	changed, err := store.SetAgeBulk(ctx, []string{"a", "b", "c"}, ageOf(AgeKid), "admin")
	if err != nil {
		t.Fatalf("bulk: %v", err)
	}
	if changed != 2 {
		t.Errorf("changed = %d, want 2 (a was already 7)", changed)
	}

	for _, id := range []string{"a", "b", "c"} {
		got, _ := store.GetAge(ctx, id)
		if got == nil || *got != AgeKid {
			t.Errorf("%s = %v, want 7", id, got)
		}
	}
}

func TestSetAgeBulkRollsBackOnError(t *testing.T) {
	conn, store := openStore(t)
	ctx := context.Background()

	if _, err := store.SetAge(ctx, "pre-existing", ageOf(AgeKid), "admin"); err != nil {
		t.Fatal(err)
	}

	if _, err := conn.Exec(`DROP TABLE categorizations`); err != nil {
		t.Fatal(err)
	}

	_, err := store.SetAgeBulk(ctx, []string{"x", "y"}, ageOf(AgeKid), "admin")
	if err == nil {
		t.Error("expected bulk to fail when table missing")
	}
}

func TestGetAgesForItems(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	if _, err := store.SetAge(ctx, "a", ageOf(AgeKid), "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetAge(ctx, "b", ageOf(AgeAdult), "admin"); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetAgesForItems(ctx, []string{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	if got["a"] != AgeKid || got["b"] != AgeAdult {
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
		store.SetAge(ctx, "item", ageOf(AgeKid), "admin")
		store.SetAge(ctx, "item", ageOf(AgeAdult), "admin")
	}

	hist, err := store.RecentHistory(ctx, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) > 5 {
		t.Errorf("hist len = %d, want <= 5", len(hist))
	}
}

func TestListItemIDsInBucket(t *testing.T) {
	_, store := openStore(t)
	ctx := context.Background()

	store.SetAge(ctx, "a", ageOf(AgeToddler), "admin")
	store.SetAge(ctx, "b", ageOf(AgeKid), "admin")
	store.SetAge(ctx, "c", ageOf(AgeAdult), "admin")
	store.SetAge(ctx, "d", ageOf(AgeTeen), "admin")

	kids, err := store.ListItemIDsInBucket(ctx, BucketKid, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(kids) != 2 {
		t.Errorf("kids = %v, want a + b (len 2)", kids)
	}

	adults, err := store.ListItemIDsInBucket(ctx, BucketAdult, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(adults) != 2 {
		t.Errorf("adults = %v, want c + d (len 2)", adults)
	}
}

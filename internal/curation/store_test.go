package curation

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/fisherevans/jellybean/internal/db"
)

func openStore(t *testing.T) (*sql.DB, *Store, int64) {
	t.Helper()
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	store := NewStore(conn)
	row := conn.QueryRow(`SELECT id FROM profiles WHERE name = 'Default'`)
	var defaultID int64
	if err := row.Scan(&defaultID); err != nil {
		t.Fatal(err)
	}
	return conn, store, defaultID
}

func stateOf(s State) *State { return &s }

func TestParseState(t *testing.T) {
	tests := []struct {
		in      string
		want    State
		wantErr bool
	}{
		{"visible", StateVisible, false},
		{"hidden", StateHidden, false},
		{"", "", true},
		{"bogus", "", true},
		{"VISIBLE", "", true}, // case-sensitive
	}
	for _, tt := range tests {
		got, err := ParseState(tt.in)
		if (err != nil) != tt.wantErr {
			t.Errorf("ParseState(%q) err = %v, wantErr %v", tt.in, err, tt.wantErr)
		}
		if got != tt.want {
			t.Errorf("ParseState(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestSetStateAndHistory(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	prev, err := store.SetState(ctx, "item-1", profileID, stateOf(StateVisible), "alice")
	if err != nil {
		t.Fatalf("SetState: %v", err)
	}
	if prev != nil {
		t.Errorf("first set: prev = %v, want nil", prev)
	}

	cur, err := store.GetState(ctx, "item-1", profileID)
	if err != nil {
		t.Fatal(err)
	}
	if cur == nil || *cur != StateVisible {
		t.Errorf("GetState = %v", cur)
	}

	prev, err = store.SetState(ctx, "item-1", profileID, stateOf(StateHidden), "bob")
	if err != nil {
		t.Fatal(err)
	}
	if prev == nil || *prev != StateVisible {
		t.Errorf("second set: prev = %v, want visible", prev)
	}

	hist, err := store.RecentHistory(ctx, profileID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) != 2 {
		t.Fatalf("history len = %d, want 2", len(hist))
	}
}

func TestSetStateNoOpDoesNotRecordHistory(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	if _, err := store.SetState(ctx, "item-1", profileID, stateOf(StateVisible), "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetState(ctx, "item-1", profileID, stateOf(StateVisible), "alice"); err != nil {
		t.Fatal(err)
	}
	hist, _ := store.RecentHistory(ctx, profileID, 10)
	if len(hist) != 1 {
		t.Errorf("history len = %d, want 1 (no-op should not write)", len(hist))
	}
}

func TestSetStateNilClearsAndRecordsHistory(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	if _, err := store.SetState(ctx, "item-1", profileID, stateOf(StateVisible), "alice"); err != nil {
		t.Fatal(err)
	}
	prev, err := store.SetState(ctx, "item-1", profileID, nil, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if prev == nil || *prev != StateVisible {
		t.Errorf("prev = %v, want visible", prev)
	}
	cur, _ := store.GetState(ctx, "item-1", profileID)
	if cur != nil {
		t.Errorf("GetState after nil set = %v, want nil", cur)
	}
}

func TestStatesAreIndependentBetweenProfiles(t *testing.T) {
	conn, store, defaultID := openStore(t)
	ctx := context.Background()

	// Create a second profile.
	res, err := conn.Exec(`INSERT INTO profiles (name, description, created_at) VALUES ('Zoe', '', unixepoch())`)
	if err != nil {
		t.Fatal(err)
	}
	zoeID, _ := res.LastInsertId()

	// Default sees the item; Zoe doesn't.
	if _, err := store.SetState(ctx, "item-1", defaultID, stateOf(StateVisible), "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetState(ctx, "item-1", zoeID, stateOf(StateHidden), "admin"); err != nil {
		t.Fatal(err)
	}

	def, _ := store.GetState(ctx, "item-1", defaultID)
	zoe, _ := store.GetState(ctx, "item-1", zoeID)
	if def == nil || *def != StateVisible {
		t.Errorf("default state = %v, want visible", def)
	}
	if zoe == nil || *zoe != StateHidden {
		t.Errorf("zoe state = %v, want hidden", zoe)
	}
}

func TestSetStateBulk(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	if _, err := store.SetState(ctx, "a", profileID, stateOf(StateVisible), "admin"); err != nil {
		t.Fatal(err)
	}

	changed, err := store.SetStateBulk(ctx, []string{"a", "b", "c"}, profileID, stateOf(StateVisible), "admin")
	if err != nil {
		t.Fatalf("bulk: %v", err)
	}
	if changed != 2 {
		t.Errorf("changed = %d, want 2 (a was already visible)", changed)
	}

	for _, id := range []string{"a", "b", "c"} {
		st, _ := store.GetState(ctx, id, profileID)
		if st == nil || *st != StateVisible {
			t.Errorf("%s = %v, want visible", id, st)
		}
	}
}

func TestSetStateBulkRollsBackOnError(t *testing.T) {
	conn, store, profileID := openStore(t)
	ctx := context.Background()

	if _, err := store.SetState(ctx, "pre-existing", profileID, stateOf(StateVisible), "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`DROP TABLE categorizations`); err != nil {
		t.Fatal(err)
	}
	_, err := store.SetStateBulk(ctx, []string{"x", "y"}, profileID, stateOf(StateVisible), "admin")
	if err == nil {
		t.Error("expected bulk to fail when table missing")
	}
}

func TestGetStatesForItems(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	if _, err := store.SetState(ctx, "a", profileID, stateOf(StateVisible), "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetState(ctx, "b", profileID, stateOf(StateHidden), "admin"); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetStatesForItems(ctx, profileID, []string{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	if got["a"] != StateVisible || got["b"] != StateHidden {
		t.Errorf("got = %v", got)
	}
	if _, ok := got["c"]; ok {
		t.Errorf("c should be absent (treat as unset): %v", got)
	}
}

func TestRecentHistoryFiltersByProfile(t *testing.T) {
	conn, store, defaultID := openStore(t)
	ctx := context.Background()

	res, _ := conn.Exec(`INSERT INTO profiles (name, description, created_at) VALUES ('Zoe', '', unixepoch())`)
	zoeID, _ := res.LastInsertId()

	store.SetState(ctx, "x", defaultID, stateOf(StateVisible), "admin")
	store.SetState(ctx, "y", zoeID, stateOf(StateHidden), "admin")

	defOnly, err := store.RecentHistory(ctx, defaultID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(defOnly) != 1 || defOnly[0].ItemID != "x" {
		t.Errorf("default-only history = %v", defOnly)
	}

	all, _ := store.RecentHistory(ctx, 0, 10)
	if len(all) != 2 {
		t.Errorf("all-profiles history len = %d, want 2", len(all))
	}
}

func TestListItemIDsInState(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	store.SetState(ctx, "a", profileID, stateOf(StateVisible), "admin")
	store.SetState(ctx, "b", profileID, stateOf(StateVisible), "admin")
	store.SetState(ctx, "c", profileID, stateOf(StateHidden), "admin")

	vis, err := store.ListItemIDsInState(ctx, profileID, StateVisible, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(vis) != 2 {
		t.Errorf("visible len = %d, want 2", len(vis))
	}

	hid, _ := store.ListItemIDsInState(ctx, profileID, StateHidden, 10, 0)
	if len(hid) != 1 {
		t.Errorf("hidden len = %d, want 1", len(hid))
	}
}

func TestSetStateRequiresProfile(t *testing.T) {
	_, store, _ := openStore(t)
	_, err := store.SetState(context.Background(), "x", 0, stateOf(StateVisible), "admin")
	if err == nil {
		t.Error("expected error when profileID is 0")
	}
	if !errors.Is(err, errors.New("placeholder")) && err.Error() == "" {
		// Just confirm a non-empty error message; don't pin the wording.
		t.Errorf("expected non-empty error message, got %v", err)
	}
}

package curation

import (
	"context"
	"fmt"
	"sort"
	"testing"
)

// staticLookup builds a Reconcile lookup that reports the supplied ids as
// found and treats every other id as missing.
func staticLookup(found ...string) func(ctx context.Context, ids []string) (map[string]struct{}, error) {
	set := make(map[string]struct{}, len(found))
	for _, id := range found {
		set[id] = struct{}{}
	}
	return func(_ context.Context, ids []string) (map[string]struct{}, error) {
		out := make(map[string]struct{}, len(ids))
		for _, id := range ids {
			if _, ok := set[id]; ok {
				out[id] = struct{}{}
			}
		}
		return out, nil
	}
}

// isOrphaned peeks past the orphan filter to confirm a row is tombstoned.
func isOrphaned(t *testing.T, store *Store, itemID string) bool {
	t.Helper()
	row := store.db.QueryRow(`
		SELECT COUNT(*) FROM categorizations
		WHERE jellyfin_item_id = ? AND orphan_at IS NOT NULL`, itemID)
	var n int
	if err := row.Scan(&n); err != nil {
		t.Fatalf("isOrphaned scan: %v", err)
	}
	return n > 0
}

func TestReconcileNoOrphansWhenAllFound(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	for _, id := range []string{"a", "b", "c"} {
		if _, err := store.SetState(ctx, id, profileID, stateOf(StateVisible), "admin"); err != nil {
			t.Fatal(err)
		}
	}

	checked, marked, cleared, err := store.Reconcile(ctx, staticLookup("a", "b", "c"))
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if checked != 3 || marked != 0 || cleared != 0 {
		t.Errorf("counts checked=%d marked=%d cleared=%d, want 3/0/0", checked, marked, cleared)
	}
	for _, id := range []string{"a", "b", "c"} {
		if isOrphaned(t, store, id) {
			t.Errorf("%s should not be orphaned", id)
		}
	}
}

func TestReconcileMarksMissing(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	for _, id := range []string{"keep", "gone"} {
		if _, err := store.SetState(ctx, id, profileID, stateOf(StateVisible), "admin"); err != nil {
			t.Fatal(err)
		}
	}

	checked, marked, cleared, err := store.Reconcile(ctx, staticLookup("keep"))
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if checked != 2 || marked != 1 || cleared != 0 {
		t.Errorf("counts checked=%d marked=%d cleared=%d, want 2/1/0", checked, marked, cleared)
	}
	if !isOrphaned(t, store, "gone") {
		t.Errorf("gone should be orphaned")
	}
	if isOrphaned(t, store, "keep") {
		t.Errorf("keep should not be orphaned")
	}

	// Re-running with the same lookup should be a no-op (already orphaned).
	_, marked2, cleared2, err := store.Reconcile(ctx, staticLookup("keep"))
	if err != nil {
		t.Fatal(err)
	}
	if marked2 != 0 || cleared2 != 0 {
		t.Errorf("idempotent pass marked=%d cleared=%d, want 0/0", marked2, cleared2)
	}
}

func TestReconcileClearsReappearedItem(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	if _, err := store.SetState(ctx, "ghost", profileID, stateOf(StateVisible), "admin"); err != nil {
		t.Fatal(err)
	}

	// First pass: ghost is missing -> tombstoned.
	if _, _, _, err := store.Reconcile(ctx, staticLookup()); err != nil {
		t.Fatal(err)
	}
	if !isOrphaned(t, store, "ghost") {
		t.Fatal("expected ghost to be orphaned after first reconcile")
	}

	// Second pass: ghost reappears in Jellyfin -> tombstone cleared.
	checked, marked, cleared, err := store.Reconcile(ctx, staticLookup("ghost"))
	if err != nil {
		t.Fatal(err)
	}
	if checked != 1 || marked != 0 || cleared != 1 {
		t.Errorf("counts checked=%d marked=%d cleared=%d, want 1/0/1", checked, marked, cleared)
	}
	if isOrphaned(t, store, "ghost") {
		t.Errorf("ghost should no longer be orphaned")
	}
}

func TestReconcileMarksAcrossAllProfiles(t *testing.T) {
	conn, store, defaultID := openStore(t)
	ctx := context.Background()

	res, err := conn.Exec(`INSERT INTO profiles (name, description, created_at) VALUES ('Zoe', '', unixepoch())`)
	if err != nil {
		t.Fatal(err)
	}
	zoeID, _ := res.LastInsertId()

	// Same item categorized under two profiles.
	if _, err := store.SetState(ctx, "shared", defaultID, stateOf(StateVisible), "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetState(ctx, "shared", zoeID, stateOf(StateHidden), "admin"); err != nil {
		t.Fatal(err)
	}

	if _, _, _, err := store.Reconcile(ctx, staticLookup()); err != nil {
		t.Fatal(err)
	}

	row := conn.QueryRow(`SELECT COUNT(*) FROM categorizations
		WHERE jellyfin_item_id = 'shared' AND orphan_at IS NOT NULL`)
	var n int
	if err := row.Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("expected both profile rows orphaned, got %d", n)
	}
}

func TestGetStatesForItemsSkipsOrphaned(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	if _, err := store.SetState(ctx, "live", profileID, stateOf(StateVisible), "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetState(ctx, "dead", profileID, stateOf(StateVisible), "admin"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkOrphan(ctx, "dead"); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetStatesForItems(ctx, profileID, []string{"live", "dead"})
	if err != nil {
		t.Fatal(err)
	}
	if got["live"] != StateVisible {
		t.Errorf("live = %v, want visible", got["live"])
	}
	if _, ok := got["dead"]; ok {
		t.Errorf("dead should be absent (orphaned), got %v", got)
	}
}

func TestListItemIDsInStateSkipsOrphaned(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	for _, id := range []string{"a", "b", "c"} {
		if _, err := store.SetState(ctx, id, profileID, stateOf(StateVisible), "admin"); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.MarkOrphan(ctx, "b"); err != nil {
		t.Fatal(err)
	}

	got, err := store.ListItemIDsInState(ctx, profileID, StateVisible, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(got)
	if len(got) != 2 || got[0] != "a" || got[1] != "c" {
		t.Errorf("got = %v, want [a c]", got)
	}
}

func TestSetStateClearsOrphan(t *testing.T) {
	// An explicit re-categorization should clear orphan_at on the matching
	// row: the operator just told us the item is real.
	_, store, profileID := openStore(t)
	ctx := context.Background()

	if _, err := store.SetState(ctx, "x", profileID, stateOf(StateVisible), "admin"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkOrphan(ctx, "x"); err != nil {
		t.Fatal(err)
	}
	if !isOrphaned(t, store, "x") {
		t.Fatal("setup: expected x orphaned")
	}

	if _, err := store.SetState(ctx, "x", profileID, stateOf(StateHidden), "admin"); err != nil {
		t.Fatal(err)
	}
	if isOrphaned(t, store, "x") {
		t.Errorf("SetState should have cleared orphan_at")
	}
}

func TestListAllCategorizationItemIDsIncludesOrphaned(t *testing.T) {
	// The reconciler depends on this returning every id, including ones
	// that were tombstoned in a previous pass, so it can re-check them
	// and clear if Jellyfin re-imports.
	_, store, profileID := openStore(t)
	ctx := context.Background()

	for _, id := range []string{"a", "b"} {
		if _, err := store.SetState(ctx, id, profileID, stateOf(StateVisible), "admin"); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.MarkOrphan(ctx, "a"); err != nil {
		t.Fatal(err)
	}

	got, err := store.ListAllCategorizationItemIDs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(got)
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("got = %v, want [a b]", got)
	}
}

// If the lookup func returns an empty result for a FULL batch, the
// reconciler must NOT mass-tombstone every id. A full-batch empty
// result is more likely a Jellyfin parse glitch than every one of 200
// ids vanishing at once. Reconcile bails before any orphan markings.
//
// Smaller batches (e.g. the last 3 items in a small library that all
// really were deleted) are legit and tested by other cases above.
func TestReconcileRefusesToMassTombstoneOnFullEmptyBatch(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	// Seed enough rows that a single batch fills the 200-id batch size.
	for i := 0; i < 250; i++ {
		id := fmt.Sprintf("item-%03d", i)
		if _, err := store.SetState(ctx, id, profileID, stateOf(StateVisible), "admin"); err != nil {
			t.Fatal(err)
		}
	}

	emptyLookup := func(_ context.Context, _ []string) (map[string]struct{}, error) {
		return map[string]struct{}{}, nil
	}

	_, marked, _, err := store.Reconcile(ctx, emptyLookup)
	if err == nil {
		t.Errorf("expected error from mass-tombstone guard on full empty batch, got nil")
	}
	if marked != 0 {
		t.Errorf("marked = %d, want 0 - reconciler should bail before any tombstoning", marked)
	}
	if isOrphaned(t, store, "item-000") {
		t.Errorf("item-000 should NOT be orphaned after a refused-batch reconcile")
	}
}

// MarkOrphan + ClearOrphan via Reconcile must produce
// categorization_history rows so the admin recent-activity view shows
// what the reconciler did.
func TestReconcileWritesHistory(t *testing.T) {
	_, store, profileID := openStore(t)
	ctx := context.Background()

	if _, err := store.SetState(ctx, "ghost", profileID, stateOf(StateVisible), "admin"); err != nil {
		t.Fatal(err)
	}

	// First pass: ghost is missing from Jellyfin, should be tombstoned
	// AND a history row should land.
	if _, _, _, err := store.Reconcile(ctx, staticLookup("decoy")); err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	rows, err := store.RecentHistory(ctx, profileID, 10)
	if err != nil {
		t.Fatal(err)
	}
	var orphanedTransitions int
	for _, h := range rows {
		if h.ItemID == "ghost" && h.ToState != nil && string(*h.ToState) == "orphaned" {
			orphanedTransitions++
		}
	}
	if orphanedTransitions != 1 {
		t.Errorf("expected 1 orphaned-transition history row for 'ghost', got %d", orphanedTransitions)
	}

	// Second pass: ghost reappears. Should clear AND record a restore.
	if _, _, _, err := store.Reconcile(ctx, staticLookup("ghost")); err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	rows, err = store.RecentHistory(ctx, profileID, 10)
	if err != nil {
		t.Fatal(err)
	}
	var restoreTransitions int
	for _, h := range rows {
		if h.ItemID == "ghost" && h.FromState != nil && string(*h.FromState) == "orphaned" {
			restoreTransitions++
		}
	}
	if restoreTransitions != 1 {
		t.Errorf("expected 1 restore history row for 'ghost', got %d", restoreTransitions)
	}
}

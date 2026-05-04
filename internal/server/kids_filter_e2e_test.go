package server

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// TestKidsLibraryRespectsFilterOverrides confirms the M6 acceptance
// criterion from #38: GET /api/kids/library returns items made
// visible by an always_visible filter even when their categorization
// would hide them, and conversely items hidden by always_hidden don't
// surface even if categorized visible.
//
// Without this test, EffectiveItemVisibility lives in isolation and
// nothing enforces that the kid path actually goes through it.
func TestKidsLibraryRespectsFilterOverrides(t *testing.T) {
	library := []jellyfin.Item{
		{ID: "always-visible-by-tag", Name: "Family Movie", Type: "Movie"},
		{ID: "always-hidden-by-tag", Name: "Bedtime Story", Type: "Movie"},
		{ID: "categorized-visible-no-tag", Name: "Plain Movie", Type: "Movie"},
		{ID: "conflict", Name: "Conflicted Movie", Type: "Movie"},
	}
	srv, _ := kidsTestServer(t, library, nil, nil)
	curStore := curation.NewStore(srv.db)
	ctx := context.Background()

	var defaultID int64
	if err := srv.db.QueryRow(`SELECT id FROM profiles WHERE name = 'Default'`).Scan(&defaultID); err != nil {
		t.Fatal(err)
	}

	// Create two tags + two filters: family => always_visible, scary
	// => always_hidden.
	family, err := curStore.CreateTag(ctx, curation.TagInput{Name: "Family"})
	if err != nil {
		t.Fatal(err)
	}
	scary, err := curStore.CreateTag(ctx, curation.TagInput{Name: "Scary"})
	if err != nil {
		t.Fatal(err)
	}
	if err := curStore.SetProfileTagFilter(ctx, defaultID, family.ID, curation.FilterAlwaysVisible); err != nil {
		t.Fatal(err)
	}
	if err := curStore.SetProfileTagFilter(ctx, defaultID, scary.ID, curation.FilterAlwaysHidden); err != nil {
		t.Fatal(err)
	}

	// Apply tags to items + categorizations to cover the four cases.
	visible := curation.StateVisible
	hidden := curation.StateHidden
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	// (a) Tagged Family + categorized hidden -> should show via always_visible.
	must(curStore.AddItemTag(ctx, "always-visible-by-tag", family.ID, ""))
	if _, err := curStore.SetState(ctx, "always-visible-by-tag", defaultID, &hidden, "test"); err != nil {
		t.Fatal(err)
	}
	// (b) Tagged Scary + categorized visible -> should hide via always_hidden.
	must(curStore.AddItemTag(ctx, "always-hidden-by-tag", scary.ID, ""))
	if _, err := curStore.SetState(ctx, "always-hidden-by-tag", defaultID, &visible, "test"); err != nil {
		t.Fatal(err)
	}
	// (c) No tags + categorized visible -> shows via categorization.
	if _, err := curStore.SetState(ctx, "categorized-visible-no-tag", defaultID, &visible, "test"); err != nil {
		t.Fatal(err)
	}
	// (d) Tagged BOTH Family AND Scary -> always_hidden wins.
	must(curStore.AddItemTag(ctx, "conflict", family.ID, ""))
	must(curStore.AddItemTag(ctx, "conflict", scary.ID, ""))
	if _, err := curStore.SetState(ctx, "conflict", defaultID, &visible, "test"); err != nil {
		t.Fatal(err)
	}

	rec := kidRequest(srv, http.MethodGet, "/api/kids/library?type=Movie", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("library -> %d body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Items []struct{ Id string }
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, it := range resp.Items {
		got[it.Id] = true
	}
	if !got["always-visible-by-tag"] {
		t.Errorf("always_visible filter should override hidden categorization")
	}
	if got["always-hidden-by-tag"] {
		t.Errorf("always_hidden filter should override visible categorization")
	}
	if !got["categorized-visible-no-tag"] {
		t.Errorf("plain visible categorization should still show through")
	}
	if got["conflict"] {
		t.Errorf("always_hidden should win over always_visible on conflicting tags")
	}
}

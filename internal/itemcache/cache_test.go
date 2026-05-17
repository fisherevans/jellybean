package itemcache

import (
	"context"
	"testing"

	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/db"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// fakeJellyfin returns a fixed item set for each Refresh. Swappable
// between calls so tests can simulate Jellyfin gaining + losing items
// between scans.
type fakeJellyfin struct {
	items []jellyfin.Item
}

func (f *fakeJellyfin) GetItems(_ context.Context, filter jellyfin.ItemsFilter) (*jellyfin.ItemsResult, error) {
	// Honor the StartIndex / Limit for paging; nothing else matters
	// for the test cache's fetcher.
	start := filter.StartIndex
	end := start + filter.Limit
	if end > len(f.items) {
		end = len(f.items)
	}
	if start > len(f.items) {
		start = len(f.items)
	}
	page := append([]jellyfin.Item(nil), f.items[start:end]...)
	return &jellyfin.ItemsResult{Items: page, TotalRecordCount: len(f.items)}, nil
}

func TestCacheRefreshUpsertsAndDeletesStale(t *testing.T) {
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	defer conn.Close()

	jf := &fakeJellyfin{}
	c := New(conn, jf, zerolog.Nop())
	ctx := context.Background()

	// First scan: three movies.
	jf.items = []jellyfin.Item{
		{ID: "m1", Name: "Alpha", Type: "Movie", ProductionYear: 2020},
		{ID: "m2", Name: "Beta", Type: "Movie", ProductionYear: 2021},
		{ID: "m3", Name: "Gamma", Type: "Movie", ProductionYear: 2022},
	}
	if err := c.Refresh(ctx); err != nil {
		t.Fatalf("first refresh: %v", err)
	}
	rows, err := c.ListByType(ctx, []string{"Movie"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got, want := len(rows), 3; got != want {
		t.Fatalf("first scan rows = %d, want %d", got, want)
	}

	// Second scan: drop m2, add m4. m1 unchanged, m3 renamed.
	jf.items = []jellyfin.Item{
		{ID: "m1", Name: "Alpha", Type: "Movie", ProductionYear: 2020},
		{ID: "m3", Name: "Gamma Renamed", Type: "Movie", ProductionYear: 2022},
		{ID: "m4", Name: "Delta", Type: "Movie", ProductionYear: 2023},
	}
	if err := c.Refresh(ctx); err != nil {
		t.Fatalf("second refresh: %v", err)
	}
	rows, err = c.ListByType(ctx, []string{"Movie"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got, want := len(rows), 3; got != want {
		t.Fatalf("second scan rows = %d, want %d", got, want)
	}

	byID, err := c.GetMany(ctx, []string{"m1", "m2", "m3", "m4"})
	if err != nil {
		t.Fatalf("getmany: %v", err)
	}
	if _, ok := byID["m2"]; ok {
		t.Errorf("stale id m2 not deleted")
	}
	if _, ok := byID["m4"]; !ok {
		t.Errorf("new id m4 not inserted")
	}
	if got := byID["m3"].Name; got != "Gamma Renamed" {
		t.Errorf("m3 name = %q, want %q (existing row not updated)", got, "Gamma Renamed")
	}

	// scan_id should have advanced from 1 to 2.
	status, err := c.Status(ctx)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status.LastScanID < 2 {
		t.Errorf("LastScanID = %d, want >= 2", status.LastScanID)
	}
	if status.LastScanError != "" {
		t.Errorf("LastScanError = %q, want empty", status.LastScanError)
	}
	if status.RowCount != 3 {
		t.Errorf("RowCount = %d, want 3", status.RowCount)
	}
}

func TestCacheRefreshDenormalizesAudioLanguage(t *testing.T) {
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	defer conn.Close()

	jf := &fakeJellyfin{items: []jellyfin.Item{
		{
			ID: "with-default", Name: "WithDefault", Type: "Movie",
			MediaStreams: []jellyfin.MediaStream{
				{Type: "Audio", Language: "eng", IsDefault: true, Index: 1},
				{Type: "Audio", Language: "spa", IsDefault: false, Index: 2},
			},
		},
		{
			ID: "no-default", Name: "NoDefault", Type: "Movie",
			MediaStreams: []jellyfin.MediaStream{
				{Type: "Audio", Language: "jpn", IsDefault: false, Index: 1},
			},
		},
		{
			ID: "no-audio", Name: "NoAudio", Type: "Movie",
		},
	}}
	c := New(conn, jf, zerolog.Nop())
	ctx := context.Background()
	if err := c.Refresh(ctx); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	rows, err := c.GetMany(ctx, []string{"with-default", "no-default", "no-audio"})
	if err != nil {
		t.Fatalf("getmany: %v", err)
	}
	if got := rows["with-default"]; got.PrimaryAudioLanguage != "eng" || got.HasNonDefaultAudioLanguage {
		t.Errorf("with-default = %+v", got)
	}
	if got := rows["no-default"]; got.PrimaryAudioLanguage != "jpn" || !got.HasNonDefaultAudioLanguage {
		t.Errorf("no-default = %+v", got)
	}
	if got := rows["no-audio"]; got.HasNonDefaultAudioLanguage {
		t.Errorf("no-audio HasNonDefaultAudioLanguage = true, want false")
	}
	if got := rows["with-default"].AudioLanguages; len(got) != 2 || got[0] != "eng" || got[1] != "spa" {
		t.Errorf("with-default AudioLanguages = %v, want [eng spa]", got)
	}
}

func TestCacheIsEmpty(t *testing.T) {
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	defer conn.Close()
	c := New(conn, &fakeJellyfin{}, zerolog.Nop())
	ctx := context.Background()

	empty, err := c.IsEmpty(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !empty {
		t.Errorf("IsEmpty = false on fresh schema")
	}

	c.jf = &fakeJellyfin{items: []jellyfin.Item{{ID: "x", Name: "X", Type: "Movie"}}}
	if err := c.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	empty, err = c.IsEmpty(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if empty {
		t.Errorf("IsEmpty = true after Refresh")
	}
}

func TestCacheListByTypeOrdersBySortNameNocase(t *testing.T) {
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	defer conn.Close()
	jf := &fakeJellyfin{items: []jellyfin.Item{
		{ID: "1", Name: "the Bee Movie", Type: "Movie"},
		{ID: "2", Name: "A Christmas Carol", Type: "Movie"},
		{ID: "3", Name: "Apple", Type: "Movie"},
	}}
	c := New(conn, jf, zerolog.Nop())
	ctx := context.Background()
	if err := c.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	rows, err := c.ListByType(ctx, []string{"Movie"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Apple", "Bee Movie", "Christmas Carol"}
	if len(rows) != len(want) {
		t.Fatalf("rows = %d, want %d", len(rows), len(want))
	}
	for i, r := range rows {
		if r.SortName != want[i] {
			t.Errorf("row %d sort_name = %q, want %q", i, r.SortName, want[i])
		}
	}
}

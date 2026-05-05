package curation

import (
	"context"
	"testing"
	"time"
)

func newBodyBreakStore(t *testing.T) (*Store, int64, int64) {
	t.Helper()
	_, store, profileID := openStore(t)
	res, err := store.db.ExecContext(context.Background(),
		`INSERT INTO kids (name, profile_id, jellyfin_user_id, created_at) VALUES (?, ?, ?, strftime('%s','now'))`,
		"break-kid", profileID, "jf-break")
	if err != nil {
		t.Fatal(err)
	}
	kidID, _ := res.LastInsertId()
	return store, kidID, profileID
}

func TestBodyBreaksDefaultsWhenNoRow(t *testing.T) {
	store, _, profileID := newBodyBreakStore(t)
	cfg, err := store.GetProfileBodyBreaks(context.Background(), profileID)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Enabled {
		t.Error("default Enabled = true")
	}
	if cfg.PlayMinutes != 30 || cfg.BreakMinutes != 5 {
		t.Errorf("got play=%d break=%d", cfg.PlayMinutes, cfg.BreakMinutes)
	}
	if len(cfg.Reasons) == 0 {
		t.Error("default Reasons is empty")
	}
}

func TestRecordPlayActivityIncrementsAndDecays(t *testing.T) {
	store, kidID, profileID := newBodyBreakStore(t)
	ctx := context.Background()
	if err := store.UpsertProfileBodyBreaks(ctx, ProfileBodyBreaks{
		ProfileID: profileID, Enabled: true, PlayMinutes: 5, BreakMinutes: 1,
	}); err != nil {
		t.Fatal(err)
	}
	t0 := time.Date(2025, 5, 4, 12, 0, 0, 0, time.UTC)
	// First report (creates the row, no delta).
	if err := store.RecordPlayActivity(ctx, kidID, "movie-1", "", false, t0); err != nil {
		t.Fatal(err)
	}
	// 60s later, still playing.
	if err := store.RecordPlayActivity(ctx, kidID, "movie-1", "", false, t0.Add(60*time.Second)); err != nil {
		t.Fatal(err)
	}
	st, err := store.GetBodyBreakStatus(ctx, kidID, profileID, t0.Add(60*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if got := st.AccumulatorMin; got < 0.95 || got > 1.05 {
		t.Errorf("AccumulatorMin = %v, want ~1", got)
	}
	if st.OnBreak {
		t.Error("OnBreak=true at 1 min with 5 min cap")
	}
	// 30s pause: should decay.
	if err := store.RecordPlayActivity(ctx, kidID, "movie-1", "", true, t0.Add(90*time.Second)); err != nil {
		t.Fatal(err)
	}
	st, _ = store.GetBodyBreakStatus(ctx, kidID, profileID, t0.Add(90*time.Second))
	if got := st.AccumulatorMin; got > 0.55 {
		t.Errorf("AccumulatorMin after decay = %v, want < 0.55", got)
	}
}

func TestCrossContentResetsAccumulator(t *testing.T) {
	store, kidID, profileID := newBodyBreakStore(t)
	ctx := context.Background()
	if err := store.UpsertProfileBodyBreaks(ctx, ProfileBodyBreaks{
		ProfileID: profileID, Enabled: true, PlayMinutes: 30, BreakMinutes: 5,
	}); err != nil {
		t.Fatal(err)
	}
	t0 := time.Date(2025, 5, 4, 12, 0, 0, 0, time.UTC)
	_ = store.RecordPlayActivity(ctx, kidID, "ep-1", "series-A", false, t0)
	_ = store.RecordPlayActivity(ctx, kidID, "ep-1", "series-A", false, t0.Add(120*time.Second))
	st, _ := store.GetBodyBreakStatus(ctx, kidID, profileID, t0.Add(120*time.Second))
	if st.AccumulatorMin < 1.5 {
		t.Fatalf("expected accumulator near 2 min, got %v", st.AccumulatorMin)
	}
	// Switch to a different series: should reset.
	_ = store.RecordPlayActivity(ctx, kidID, "ep-1", "series-B", false, t0.Add(125*time.Second))
	st, _ = store.GetBodyBreakStatus(ctx, kidID, profileID, t0.Add(125*time.Second))
	if st.AccumulatorMin > 0.1 {
		t.Errorf("AccumulatorMin = %v after content swap, want 0", st.AccumulatorMin)
	}
}

func TestSameSeriesNextEpisodeDoesNotReset(t *testing.T) {
	store, kidID, profileID := newBodyBreakStore(t)
	ctx := context.Background()
	_ = store.UpsertProfileBodyBreaks(ctx, ProfileBodyBreaks{
		ProfileID: profileID, Enabled: true, PlayMinutes: 30, BreakMinutes: 5,
	})
	t0 := time.Date(2025, 5, 4, 12, 0, 0, 0, time.UTC)
	_ = store.RecordPlayActivity(ctx, kidID, "ep-1", "series-A", false, t0)
	_ = store.RecordPlayActivity(ctx, kidID, "ep-1", "series-A", false, t0.Add(60*time.Second))
	// Same series, different episode.
	_ = store.RecordPlayActivity(ctx, kidID, "ep-2", "series-A", false, t0.Add(65*time.Second))
	st, _ := store.GetBodyBreakStatus(ctx, kidID, profileID, t0.Add(65*time.Second))
	if st.AccumulatorMin < 1.0 {
		t.Errorf("AccumulatorMin = %v, want >= ~1 (no reset on same series)", st.AccumulatorMin)
	}
}

func TestBreakTriggersAtThreshold(t *testing.T) {
	store, kidID, profileID := newBodyBreakStore(t)
	ctx := context.Background()
	_ = store.UpsertProfileBodyBreaks(ctx, ProfileBodyBreaks{
		ProfileID: profileID, Enabled: true, PlayMinutes: 1, BreakMinutes: 1,
	})
	t0 := time.Date(2025, 5, 4, 12, 0, 0, 0, time.UTC)
	_ = store.RecordPlayActivity(ctx, kidID, "movie-1", "", false, t0)
	// 65s later, past the threshold.
	_ = store.RecordPlayActivity(ctx, kidID, "movie-1", "", false, t0.Add(65*time.Second))
	st, err := store.GetBodyBreakStatus(ctx, kidID, profileID, t0.Add(65*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !st.OnBreak {
		t.Errorf("OnBreak=false past threshold: %+v", st)
	}
	if st.VoiceMessage == "" {
		t.Error("VoiceMessage empty during break")
	}
}

func TestEndBreakClearsState(t *testing.T) {
	store, kidID, profileID := newBodyBreakStore(t)
	ctx := context.Background()
	_ = store.UpsertProfileBodyBreaks(ctx, ProfileBodyBreaks{
		ProfileID: profileID, Enabled: true, PlayMinutes: 1, BreakMinutes: 5,
	})
	t0 := time.Date(2025, 5, 4, 12, 0, 0, 0, time.UTC)
	_, err := store.StartBreak(ctx, kidID, profileID, t0)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EndBreak(ctx, kidID, t0.Add(time.Minute), true); err != nil {
		t.Fatal(err)
	}
	st, _ := store.GetBodyBreakStatus(ctx, kidID, profileID, t0.Add(time.Minute))
	if st.OnBreak {
		t.Errorf("OnBreak=true after EndBreak: %+v", st)
	}
}

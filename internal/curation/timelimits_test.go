package curation

import (
	"context"
	"sync"
	"testing"
	"time"
)

// Time-limits engine tests: the bucket math, watch-segment derivation,
// and grant accounting. The interesting cases are anchored to a
// fixed `now` so the tests are deterministic; ChicagoIsh time zone
// math is dodged by using UTC and explicit hours.

func newTimeStore(t *testing.T) (*Store, int64, int64) {
	t.Helper()
	_, store, profileID := openStore(t)
	res, err := store.db.ExecContext(context.Background(),
		`INSERT INTO kids (name, profile_id, jellyfin_user_id, created_at) VALUES (?, ?, ?, strftime('%s','now'))`,
		"test-kid", profileID, "jf-user-test")
	if err != nil {
		t.Fatalf("seed kid: %v", err)
	}
	kidID, _ := res.LastInsertId()
	return store, kidID, profileID
}

func TestProfileTimeLimitsDefaultsWhenNoRow(t *testing.T) {
	store, _, profileID := newTimeStore(t)
	got, err := store.GetProfileTimeLimits(context.Background(), profileID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Enabled {
		t.Error("default Enabled = true, want false")
	}
	if got.DailyCapMinutes != 240 {
		t.Errorf("DailyCapMinutes = %d, want 240", got.DailyCapMinutes)
	}
	if got.RefillIntervalHours != 1 {
		t.Errorf("RefillIntervalHours = %d, want 1", got.RefillIntervalHours)
	}
}

func TestUpsertProfileTimeLimitsRoundTrip(t *testing.T) {
	store, _, profileID := newTimeStore(t)
	showCap := 30
	in := ProfileTimeLimits{
		ProfileID:             profileID,
		Enabled:               true,
		DailyCapMinutes:       180,
		RefillIntervalHours:   4,
		DayStartHour:          6,
		DefaultShowCapMinutes: &showCap,
	}
	if err := store.UpsertProfileTimeLimits(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	out, err := store.GetProfileTimeLimits(context.Background(), profileID)
	if err != nil {
		t.Fatal(err)
	}
	if out.DailyCapMinutes != 180 || out.RefillIntervalHours != 4 || out.DayStartHour != 6 {
		t.Errorf("got %+v", out)
	}
	if out.DefaultShowCapMinutes == nil || *out.DefaultShowCapMinutes != 30 {
		t.Errorf("DefaultShowCapMinutes = %v, want 30", out.DefaultShowCapMinutes)
	}
}

func TestUpsertProfileTimeLimitsRejectsBadValues(t *testing.T) {
	store, _, profileID := newTimeStore(t)
	bad := []ProfileTimeLimits{
		{ProfileID: profileID, RefillIntervalHours: 3, DailyCapMinutes: 60, DayStartHour: 0},
		{ProfileID: profileID, RefillIntervalHours: 1, DailyCapMinutes: -1, DayStartHour: 0},
		{ProfileID: profileID, RefillIntervalHours: 1, DailyCapMinutes: 60, DayStartHour: 24},
	}
	for i, b := range bad {
		if err := store.UpsertProfileTimeLimits(context.Background(), b); err == nil {
			t.Errorf("case %d: expected error, got nil", i)
		}
	}
}

func TestComputeTimeStatusDisabledMeansUnlimited(t *testing.T) {
	store, kidID, profileID := newTimeStore(t)
	st, err := store.ComputeTimeStatus(context.Background(), kidID, profileID, time.Now(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if st.Enabled {
		t.Error("Enabled = true, want false")
	}
	if st.Global.Locked {
		t.Error("disabled engine returned locked=true")
	}
}

func TestComputeTimeStatusBucketRefill(t *testing.T) {
	store, kidID, profileID := newTimeStore(t)
	if err := store.UpsertProfileTimeLimits(context.Background(), ProfileTimeLimits{
		ProfileID:           profileID,
		Enabled:             true,
		DailyCapMinutes:     240,
		RefillIntervalHours: 1,
		DayStartHour:        2,
	}); err != nil {
		t.Fatal(err)
	}
	// 240 min cap / 24 refills = 10 min per refill. At 10 AM (8h
	// after 2 AM start), 80 min should be accrued.
	now := time.Date(2025, 5, 4, 10, 0, 0, 0, time.UTC)
	st, err := store.ComputeTimeStatus(context.Background(), kidID, profileID, now, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := st.Global.AvailableMinutes; got != 80 {
		t.Errorf("AvailableMinutes = %v, want 80", got)
	}
	if st.Global.Locked {
		t.Error("locked=true with 80 min available")
	}
}

func TestComputeTimeStatusLockedWhenUsageExceedsAccrual(t *testing.T) {
	store, kidID, profileID := newTimeStore(t)
	if err := store.UpsertProfileTimeLimits(context.Background(), ProfileTimeLimits{
		ProfileID:           profileID,
		Enabled:             true,
		DailyCapMinutes:     240,
		RefillIntervalHours: 1,
		DayStartHour:        2,
	}); err != nil {
		t.Fatal(err)
	}
	// At 10 AM, 80 min accrued. Watch 90 min; bucket should be 0
	// and locked (over-consumption clamps at 0).
	now := time.Date(2025, 5, 4, 10, 0, 0, 0, time.UTC)
	bucket := dayBucket(now, 2)
	if _, err := store.db.ExecContext(context.Background(), `
		INSERT INTO kid_watch_segments
		(kid_id, jellyfin_item_id, started_at, ended_at, minutes_watched, day_bucket)
		VALUES (?, ?, ?, ?, ?, ?)`,
		kidID, "movie-1", now.Add(-90*time.Minute).Unix(), now.Unix(), 90.0, bucket); err != nil {
		t.Fatal(err)
	}
	st, _ := store.ComputeTimeStatus(context.Background(), kidID, profileID, now, nil, nil)
	if st.Global.AvailableMinutes != 0 {
		t.Errorf("AvailableMinutes = %v, want 0", st.Global.AvailableMinutes)
	}
	if !st.Global.Locked {
		t.Error("locked=false with usage > accrual")
	}
}

func TestGrantsLiftBucket(t *testing.T) {
	store, kidID, profileID := newTimeStore(t)
	if err := store.UpsertProfileTimeLimits(context.Background(), ProfileTimeLimits{
		ProfileID:           profileID,
		Enabled:             true,
		DailyCapMinutes:     60,
		RefillIntervalHours: 1,
		DayStartHour:        2,
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2025, 5, 4, 4, 0, 0, 0, time.UTC) // 2h since day start
	// 2h * (60/24) = 5 min accrued.
	bucket := dayBucket(now, 2)
	if _, err := store.db.ExecContext(context.Background(), `
		INSERT INTO kid_watch_segments
		(kid_id, jellyfin_item_id, started_at, ended_at, minutes_watched, day_bucket)
		VALUES (?, ?, ?, ?, ?, ?)`,
		kidID, "movie-1", now.Add(-30*time.Minute).Unix(), now.Unix(), 30.0, bucket); err != nil {
		t.Fatal(err)
	}
	// Without the grant: -25 min, clamped to 0 + locked.
	st, _ := store.ComputeTimeStatus(context.Background(), kidID, profileID, now, nil, nil)
	if !st.Global.Locked {
		t.Errorf("expected locked before grant, got %+v", st.Global)
	}
	// Grant +60 min, no expiry (until next reset).
	mins := 60
	if _, err := store.CreateGrant(context.Background(), TimeGrant{
		KidID: kidID, GrantedAt: now, GrantedBy: "override",
		MinutesGranted: &mins, Scope: "global",
	}); err != nil {
		t.Fatal(err)
	}
	st, _ = store.ComputeTimeStatus(context.Background(), kidID, profileID, now, nil, nil)
	if st.Global.Locked {
		t.Error("still locked after +60 grant")
	}
	// 5 - 30 + 60 = 35 min available.
	if got := st.Global.AvailableMinutes; got != 35 {
		t.Errorf("AvailableMinutes = %v, want 35", got)
	}
}

func TestPerMovieStartsCap(t *testing.T) {
	store, kidID, profileID := newTimeStore(t)
	starts := 1
	if err := store.UpsertProfileTimeLimits(context.Background(), ProfileTimeLimits{
		ProfileID:           profileID,
		Enabled:             true,
		DailyCapMinutes:     1440,
		RefillIntervalHours: 1,
		DayStartHour:        0,
		DefaultMovieStarts:  &starts,
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2025, 5, 4, 12, 0, 0, 0, time.UTC)
	bucket := dayBucket(now, 0)
	// One segment for movie-1 today.
	if _, err := store.db.ExecContext(context.Background(), `
		INSERT INTO kid_watch_segments
		(kid_id, jellyfin_item_id, started_at, ended_at, minutes_watched, day_bucket)
		VALUES (?, ?, ?, ?, ?, ?)`,
		kidID, "movie-1", now.Add(-90*time.Minute).Unix(), now.Add(-30*time.Minute).Unix(), 60.0, bucket); err != nil {
		t.Fatal(err)
	}
	res, err := store.CanPlay(context.Background(), kidID, profileID, "movie-1", "", now)
	if err != nil {
		t.Fatal(err)
	}
	if res.Allowed {
		t.Errorf("CanPlay allowed=true after starts cap reached: %+v", res)
	}
	// Different movie should still play.
	res, err = store.CanPlay(context.Background(), kidID, profileID, "movie-2", "", now)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Allowed {
		t.Errorf("CanPlay denied for different movie: %+v", res)
	}
}

func TestRecordPlaybackProgressExtendsAndCloses(t *testing.T) {
	store, kidID, profileID := newTimeStore(t)
	// Limits enabled doesn't matter; segments are recorded
	// regardless. Defaults are fine.
	ctx := context.Background()
	t0 := time.Date(2025, 5, 4, 12, 0, 0, 0, time.UTC)
	if err := store.RecordPlaybackProgress(ctx, kidID, profileID, "movie-1", "", false, t0); err != nil {
		t.Fatal(err)
	}
	// 10s later, still playing.
	if err := store.RecordPlaybackProgress(ctx, kidID, profileID, "movie-1", "", false, t0.Add(10*time.Second)); err != nil {
		t.Fatal(err)
	}
	// Pause closes.
	if err := store.RecordPlaybackProgress(ctx, kidID, profileID, "movie-1", "", true, t0.Add(20*time.Second)); err != nil {
		t.Fatal(err)
	}

	var total float64
	_ = store.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(minutes_watched), 0) FROM kid_watch_segments WHERE kid_id = ?`, kidID).Scan(&total)
	// 10s of extension + 0 from open (initial 0 + 10s extension), wall
	// difference between t0 and t0+10s is 10s. The segment captured 10s
	// = 0.1666... minutes. Allow some FP tolerance.
	if total < 0.1 || total > 0.5 {
		t.Errorf("total minutes_watched = %v, want ~0.1666", total)
	}

	// Open segment table should be empty after pause.
	var n int
	_ = store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM kid_open_segments WHERE kid_id = ?`, kidID).Scan(&n)
	if n != 0 {
		t.Errorf("kid_open_segments rows = %d after pause, want 0", n)
	}
}

func TestRecordPlaybackProgressGapStartsNewSegment(t *testing.T) {
	store, kidID, profileID := newTimeStore(t)
	ctx := context.Background()
	t0 := time.Date(2025, 5, 4, 12, 0, 0, 0, time.UTC)
	if err := store.RecordPlaybackProgress(ctx, kidID, profileID, "movie-1", "", false, t0); err != nil {
		t.Fatal(err)
	}
	// Big gap (longer than progressGapThreshold) - should close & open new.
	if err := store.RecordPlaybackProgress(ctx, kidID, profileID, "movie-1", "", false, t0.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM kid_watch_segments WHERE kid_id = ?`, kidID).Scan(&n)
	if n != 2 {
		t.Errorf("segments = %d after gap, want 2", n)
	}
}

// Regression for the SQLITE_BUSY storm caught during real playback:
// the kids progress endpoint fires RecordPlaybackProgress +
// RecordPlayActivity back to back per poll, plus the body-break
// status endpoint runs on the same cadence. Concurrent writers on the
// same kid used to BUSY-out under WAL. The Store now serializes per-
// kid writes via a sync.Map of mutexes; this test fans out writers
// from goroutines and asserts every call returns nil + no deadlock.
func TestRecordPlaybackProgressConcurrentDoesNotRace(t *testing.T) {
	store, kidID, profileID := newTimeStore(t)
	ctx := context.Background()
	t0 := time.Date(2025, 5, 4, 12, 0, 0, 0, time.UTC)

	const writers = 8
	const iterations = 25

	var wg sync.WaitGroup
	errs := make(chan error, writers*iterations*2)
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				ts := t0.Add(time.Duration(w*iterations+i) * time.Second)
				if err := store.RecordPlaybackProgress(ctx, kidID, profileID, "movie-1", "", false, ts); err != nil {
					errs <- err
				}
				if err := store.RecordPlayActivity(ctx, kidID, "movie-1", "", false, ts); err != nil {
					errs <- err
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent writer: %v", err)
	}
}

func TestDayBucketAnchor(t *testing.T) {
	// 02:00 anchor: 01:30 belongs to yesterday.
	t1 := time.Date(2025, 5, 4, 1, 30, 0, 0, time.UTC)
	if got := dayBucket(t1, 2); got != "2025-05-03" {
		t.Errorf("dayBucket = %q, want 2025-05-03", got)
	}
	// 02:00 boundary: 02:00 itself rolls to today.
	t2 := time.Date(2025, 5, 4, 2, 0, 0, 0, time.UTC)
	if got := dayBucket(t2, 2); got != "2025-05-04" {
		t.Errorf("dayBucket = %q at boundary, want 2025-05-04", got)
	}
}

package curation

import (
	"context"
	"testing"
	"time"
)

func newModesStore(t *testing.T) (*Store, int64, int64) {
	t.Helper()
	_, store, profileID := openStore(t)
	res, err := store.db.ExecContext(context.Background(),
		`INSERT INTO kids (name, profile_id, jellyfin_user_id, created_at) VALUES (?, ?, ?, strftime('%s','now'))`,
		"modes-kid", profileID, "jf-modes")
	if err != nil {
		t.Fatal(err)
	}
	kidID, _ := res.LastInsertId()
	return store, kidID, profileID
}

func TestCreateAndListModes(t *testing.T) {
	store, _, profileID := newModesStore(t)
	mode, err := store.CreateMode(context.Background(), Mode{
		ProfileID:         profileID,
		Name:              "Bedtime",
		ScheduleDays:      0b1111111,
		ScheduleStartTime: "20:00",
		ScheduleEndTime:   "06:00",
		ThemeKey:          "bedtime",
	})
	if err != nil {
		t.Fatal(err)
	}
	if mode.ID == 0 {
		t.Error("ID = 0 after Create")
	}
	modes, err := store.ListModes(context.Background(), profileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(modes) != 1 || modes[0].Name != "Bedtime" {
		t.Errorf("got %+v", modes)
	}
}

func TestResolveActiveModeNoModes(t *testing.T) {
	store, kidID, profileID := newModesStore(t)
	am, err := store.ResolveActiveMode(context.Background(), kidID, profileID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if am.Source != "none" || am.Mode != nil {
		t.Errorf("got %+v, want source=none mode=nil", am)
	}
}

func TestResolveActiveModeBySchedule(t *testing.T) {
	store, kidID, profileID := newModesStore(t)
	if _, err := store.CreateMode(context.Background(), Mode{
		ProfileID:         profileID,
		Name:              "Morning",
		ScheduleDays:      0b1111111,
		ScheduleStartTime: "06:00",
		ScheduleEndTime:   "10:00",
		ThemeKey:          "morning",
	}); err != nil {
		t.Fatal(err)
	}
	// 08:00 on a Wednesday.
	at := time.Date(2025, 5, 7, 8, 0, 0, 0, time.UTC)
	am, _ := store.ResolveActiveMode(context.Background(), kidID, profileID, at)
	if am.Source != "schedule" || am.Mode == nil || am.Mode.Name != "Morning" {
		t.Errorf("got %+v, want Morning by schedule", am)
	}
	// 11:00 (after the window): no mode.
	at = time.Date(2025, 5, 7, 11, 0, 0, 0, time.UTC)
	am, _ = store.ResolveActiveMode(context.Background(), kidID, profileID, at)
	if am.Source != "none" {
		t.Errorf("got %+v, want none after window", am)
	}
}

func TestResolveActiveModeMidnightWrap(t *testing.T) {
	store, kidID, profileID := newModesStore(t)
	_, _ = store.CreateMode(context.Background(), Mode{
		ProfileID:         profileID,
		Name:              "Bedtime",
		ScheduleDays:      0b1111111,
		ScheduleStartTime: "22:00",
		ScheduleEndTime:   "06:00",
	})
	// 23:00 = inside.
	at := time.Date(2025, 5, 7, 23, 0, 0, 0, time.UTC)
	am, _ := store.ResolveActiveMode(context.Background(), kidID, profileID, at)
	if am.Mode == nil {
		t.Errorf("midnight-wrap before midnight didn't match")
	}
	// 03:00 = inside (next morning).
	at = time.Date(2025, 5, 8, 3, 0, 0, 0, time.UTC)
	am, _ = store.ResolveActiveMode(context.Background(), kidID, profileID, at)
	if am.Mode == nil {
		t.Errorf("midnight-wrap after midnight didn't match")
	}
	// 12:00 = outside.
	at = time.Date(2025, 5, 7, 12, 0, 0, 0, time.UTC)
	am, _ = store.ResolveActiveMode(context.Background(), kidID, profileID, at)
	if am.Mode != nil {
		t.Errorf("daytime returned a mode: %+v", am)
	}
}

func TestResolveActiveModeAlphabeticalPriority(t *testing.T) {
	store, kidID, profileID := newModesStore(t)
	_, _ = store.CreateMode(context.Background(), Mode{
		ProfileID: profileID, Name: "Zebra", ScheduleDays: 0b1111111,
		ScheduleStartTime: "00:00", ScheduleEndTime: "23:59",
	})
	_, _ = store.CreateMode(context.Background(), Mode{
		ProfileID: profileID, Name: "Apple", ScheduleDays: 0b1111111,
		ScheduleStartTime: "00:00", ScheduleEndTime: "23:59",
	})
	at := time.Date(2025, 5, 7, 12, 0, 0, 0, time.UTC)
	am, _ := store.ResolveActiveMode(context.Background(), kidID, profileID, at)
	if am.Mode == nil || am.Mode.Name != "Apple" {
		t.Errorf("got %+v, want Apple by alphabetical", am)
	}
}

func TestModeOverridePath(t *testing.T) {
	store, kidID, profileID := newModesStore(t)
	mode, _ := store.CreateMode(context.Background(), Mode{
		ProfileID: profileID, Name: "Focus",
		ScheduleStartTime: "00:00", ScheduleEndTime: "00:00",
	})
	until := time.Now().UTC().Add(time.Hour)
	if err := store.SetModeOverride(context.Background(), kidID, mode.ID, until); err != nil {
		t.Fatal(err)
	}
	am, _ := store.ResolveActiveMode(context.Background(), kidID, profileID, time.Now())
	if am.Source != "override" || am.Mode == nil || am.Mode.Name != "Focus" {
		t.Errorf("got %+v, want override Focus", am)
	}
	// Force-none override.
	if err := store.SetModeOverride(context.Background(), kidID, 0, until); err != nil {
		t.Fatal(err)
	}
	am, _ = store.ResolveActiveMode(context.Background(), kidID, profileID, time.Now())
	if am.Mode != nil {
		t.Errorf("force-none returned mode %+v", am.Mode)
	}
}

func TestDayOfWeekMatching(t *testing.T) {
	store, kidID, profileID := newModesStore(t)
	// Monday only: bit 0.
	_, _ = store.CreateMode(context.Background(), Mode{
		ProfileID: profileID, Name: "Mon", ScheduleDays: 1,
		ScheduleStartTime: "00:00", ScheduleEndTime: "23:59",
	})
	// 2025-05-05 is a Monday.
	monday := time.Date(2025, 5, 5, 12, 0, 0, 0, time.UTC)
	am, _ := store.ResolveActiveMode(context.Background(), kidID, profileID, monday)
	if am.Mode == nil {
		t.Errorf("Monday didn't match Mon-only schedule")
	}
	// Tuesday should not match.
	tuesday := time.Date(2025, 5, 6, 12, 0, 0, 0, time.UTC)
	am, _ = store.ResolveActiveMode(context.Background(), kidID, profileID, tuesday)
	if am.Mode != nil {
		t.Errorf("Tuesday matched Mon-only schedule: %+v", am)
	}
}

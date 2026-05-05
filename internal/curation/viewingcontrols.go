package curation

// Viewing controls (M12). Per-profile baselines for dim, red-shift,
// clock-based auto-off; per-kid override values + expiry. Engine
// returns the rendered "effective" state which the kid SPA applies
// via root-element CSS filter.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ProfileViewingControls is now just the bedtime hard cutoff. Dim
// + warm tint moved onto profile_modes (see Mode.DimPercent /
// WarmTintPercent).
type ProfileViewingControls struct {
	ProfileID        int64     `json:"profileId"`
	AutoOffClockTime string    `json:"autoOffClockTime,omitempty"` // "HH:MM" 24h
	UpdatedAt        time.Time `json:"updatedAt"`
}

type ViewingState struct {
	DimPercent            int       `json:"dimPercent"`
	WarmTintPercent       int       `json:"warmTintPercent"`
	AutoOffActive         bool      `json:"autoOffActive"`
	AutoOffReason         string    `json:"autoOffReason,omitempty"` // "clock" | "sleep_timer"
	SleepTimerAt          time.Time `json:"sleepTimerAt,omitempty"`
	NextOverrideExpiresAt time.Time `json:"nextOverrideExpiresAt,omitempty"`
}

// GetProfileViewingControls returns the row, falling back to defaults.
func (s *Store) GetProfileViewingControls(ctx context.Context, profileID int64) (*ProfileViewingControls, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT profile_id, COALESCE(auto_off_clock_time, ''), updated_at
		FROM profile_viewing_controls WHERE profile_id = ?`, profileID)
	var (
		out     ProfileViewingControls
		updated int64
	)
	err := row.Scan(&out.ProfileID, &out.AutoOffClockTime, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return &ProfileViewingControls{ProfileID: profileID}, nil
	}
	if err != nil {
		return nil, err
	}
	out.UpdatedAt = time.Unix(updated, 0).UTC()
	return &out, nil
}

func (s *Store) UpsertProfileViewingControls(ctx context.Context, p ProfileViewingControls) error {
	if p.ProfileID <= 0 {
		return errors.New("profileID required")
	}
	if p.AutoOffClockTime != "" && !validHHMM(p.AutoOffClockTime) {
		return fmt.Errorf("auto_off_clock_time %q must be HH:MM 24h", p.AutoOffClockTime)
	}
	clock := nullableString(p.AutoOffClockTime)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO profile_viewing_controls (profile_id, auto_off_clock_time, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(profile_id) DO UPDATE SET
		    auto_off_clock_time = excluded.auto_off_clock_time,
		    updated_at = excluded.updated_at`,
		p.ProfileID, clock, time.Now().Unix())
	return err
}

// SetOverride sets one of "dim", "red_shift" with the given value and
// expiry. Pass a zero time for ExpiresAt to mean "until day reset"
// (engine uses midnight in caller's clock).
func (s *Store) SetViewingOverride(ctx context.Context, kidID int64, control string, value int, expiresAt time.Time) error {
	if kidID <= 0 {
		return errors.New("kidID required")
	}
	col, untilCol, ok := viewingOverrideCols(control)
	if !ok {
		return fmt.Errorf("invalid control %q", control)
	}
	now := time.Now().UTC().Unix()
	var expires any
	if !expiresAt.IsZero() {
		expires = expiresAt.Unix()
	}
	q := fmt.Sprintf(`
		INSERT INTO kid_viewing_overrides (kid_id, %s, %s, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(kid_id) DO UPDATE SET
		    %s = excluded.%s,
		    %s = excluded.%s,
		    updated_at = excluded.updated_at`,
		col, untilCol, col, col, untilCol, untilCol)
	_, err := s.db.ExecContext(ctx, q, kidID, value, expires, now)
	return err
}

func (s *Store) ClearViewingOverride(ctx context.Context, kidID int64, control string) error {
	col, untilCol, ok := viewingOverrideCols(control)
	if !ok {
		return fmt.Errorf("invalid control %q", control)
	}
	q := fmt.Sprintf(`UPDATE kid_viewing_overrides SET %s = NULL, %s = NULL, updated_at = ? WHERE kid_id = ?`, col, untilCol)
	_, err := s.db.ExecContext(ctx, q, time.Now().UTC().Unix(), kidID)
	return err
}

func (s *Store) SetSleepTimer(ctx context.Context, kidID int64, fireAt time.Time) error {
	now := time.Now().UTC().Unix()
	var fire any
	if !fireAt.IsZero() {
		fire = fireAt.Unix()
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO kid_viewing_overrides (kid_id, sleep_timer_at, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(kid_id) DO UPDATE SET
		    sleep_timer_at = excluded.sleep_timer_at,
		    updated_at = excluded.updated_at`, kidID, fire, now)
	return err
}

// CancelAutoOff clears the active flag (and the sleep timer if any).
// Used by the override modal.
func (s *Store) CancelAutoOff(ctx context.Context, kidID int64) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE kid_viewing_overrides SET auto_off_active = 0,
		       auto_off_reason = NULL, sleep_timer_at = NULL, updated_at = ?
		WHERE kid_id = ?`, time.Now().UTC().Unix(), kidID)
	return err
}

// GetViewingState returns the rendered effective state.
//
// Resolution order for dim + warm tint:
//   1. Start at 0 (no effect).
//   2. If a mode is currently active for this kid, use that mode's
//      dim_percent / warm_tint_percent as the baseline.
//   3. If a per-kid override is set and unexpired, replace the
//      baseline with the override.
//
// Auto-off (lockout overlay) is independent of dim/warm and fires
// from one of three triggers: clock cutoff, sleep timer override,
// or already-flagged active.
func (s *Store) GetViewingState(ctx context.Context, kidID, profileID int64, now time.Time) (*ViewingState, error) {
	prof, err := s.GetProfileViewingControls(ctx, profileID)
	if err != nil {
		return nil, err
	}
	out := &ViewingState{}

	// Apply active mode's dim/warm as the baseline.
	active, err := s.ResolveActiveMode(ctx, kidID, profileID, now)
	if err == nil && active != nil && active.Mode != nil {
		out.DimPercent = active.Mode.DimPercent
		out.WarmTintPercent = active.Mode.WarmTintPercent
	}

	// Per-kid overrides.
	row := s.db.QueryRowContext(ctx, `
		SELECT dim_override, dim_override_until,
		       red_shift_override, red_shift_override_until,
		       sleep_timer_at, auto_off_active, COALESCE(auto_off_reason, '')
		FROM kid_viewing_overrides WHERE kid_id = ?`, kidID)
	var (
		dimOv         sql.NullInt64
		dimUntil      sql.NullInt64
		rsOv          sql.NullInt64
		rsUntil       sql.NullInt64
		sleepTimer    sql.NullInt64
		autoOffActive int
		autoOffReason string
	)
	err = row.Scan(&dimOv, &dimUntil, &rsOv, &rsUntil, &sleepTimer, &autoOffActive, &autoOffReason)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	var nextExpiry time.Time
	apply := func(value sql.NullInt64, until sql.NullInt64, set func(int)) {
		if !value.Valid {
			return
		}
		if until.Valid {
			t := time.Unix(until.Int64, 0).UTC()
			if now.After(t) {
				return
			}
			if nextExpiry.IsZero() || t.Before(nextExpiry) {
				nextExpiry = t
			}
		}
		set(int(value.Int64))
	}
	apply(dimOv, dimUntil, func(v int) { out.DimPercent = v })
	apply(rsOv, rsUntil, func(v int) { out.WarmTintPercent = v })
	out.NextOverrideExpiresAt = nextExpiry

	// Auto-off: if already flagged active, surface it.
	if autoOffActive != 0 {
		out.AutoOffActive = true
		out.AutoOffReason = autoOffReason
	}

	// Maybe fire from sleep timer.
	if sleepTimer.Valid {
		t := time.Unix(sleepTimer.Int64, 0).UTC()
		out.SleepTimerAt = t
		if now.After(t) && !out.AutoOffActive {
			_, _ = s.db.ExecContext(ctx, `
				UPDATE kid_viewing_overrides SET auto_off_active = 1,
				       auto_off_reason = 'sleep_timer', updated_at = ?
				WHERE kid_id = ?`, now.Unix(), kidID)
			out.AutoOffActive = true
			out.AutoOffReason = "sleep_timer"
		}
	}

	// Maybe fire from configured clock.
	if !out.AutoOffActive && prof.AutoOffClockTime != "" {
		hh, mm, _ := parseHHMM(prof.AutoOffClockTime)
		today := time.Date(now.Year(), now.Month(), now.Day(), hh, mm, 0, 0, now.Location())
		if now.After(today) {
			_, _ = s.db.ExecContext(ctx, `
				INSERT INTO kid_viewing_overrides (kid_id, auto_off_active,
				    auto_off_reason, updated_at)
				VALUES (?, 1, 'clock', ?)
				ON CONFLICT(kid_id) DO UPDATE SET
				    auto_off_active = 1,
				    auto_off_reason = 'clock',
				    updated_at = excluded.updated_at`, kidID, now.Unix())
			out.AutoOffActive = true
			out.AutoOffReason = "clock"
		}
	}

	return out, nil
}

func viewingOverrideCols(control string) (col, until string, ok bool) {
	switch control {
	case "dim":
		return "dim_override", "dim_override_until", true
	case "red_shift":
		return "red_shift_override", "red_shift_override_until", true
	}
	return "", "", false
}

func validHHMM(s string) bool {
	_, _, err := parseHHMM(s)
	return err == nil
}

func parseHHMM(s string) (hh, mm int, err error) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("expected HH:MM")
	}
	h, herr := strconv.Atoi(parts[0])
	m, merr := strconv.Atoi(parts[1])
	if herr != nil || merr != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, fmt.Errorf("invalid time %q", s)
	}
	return h, m, nil
}

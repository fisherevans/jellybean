package curation

// Body breaks (M11). Cadence = (play_minutes, break_minutes); engine
// runs an accumulator on the kid's playback activity, fires a break
// when the threshold crosses, and tracks the break end time so the
// kid client can show the lockout overlay.
//
// The accumulator decays during pause / menu / browse so a kid who
// pauses for a snack doesn't immediately trigger a break on resume.
// Cross-content swap (new series, new movie) resets the counter to
// zero - "next episode of the same series" deliberately doesn't.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"time"
)

const (
	defaultBreakReason = "a stretch"
)

// ProfileBodyBreaks is the per-profile cadence configuration.
type ProfileBodyBreaks struct {
	ProfileID            int64     `json:"profileId"`
	Enabled              bool      `json:"enabled"`
	PlayMinutes          int       `json:"playMinutes"`
	BreakMinutes         int       `json:"breakMinutes"`
	VoiceMessageTemplate string    `json:"voiceMessageTemplate"`
	Reasons              []string  `json:"reasons"`
	UpdatedAt            time.Time `json:"updatedAt"`
}

// BodyBreakStatus is the rendered state for one kid.
type BodyBreakStatus struct {
	Enabled        bool      `json:"enabled"`
	AccumulatorMin float64   `json:"accumulatorMin"`
	PlayMinutes    int       `json:"playMinutes"`
	BreakMinutes   int       `json:"breakMinutes"`
	OnBreak        bool      `json:"onBreak"`
	OnBreakUntil   time.Time `json:"onBreakUntil,omitempty"`
	OnBreakReason  string    `json:"onBreakReason,omitempty"`
	VoiceMessage   string    `json:"voiceMessage,omitempty"`
}

// GetProfileBodyBreaks returns the row for a profile, falling back to
// defaults when there's no row.
func (s *Store) GetProfileBodyBreaks(ctx context.Context, profileID int64) (*ProfileBodyBreaks, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT profile_id, enabled, play_minutes, break_minutes,
		       voice_message_template, reasons_json, updated_at
		FROM profile_body_breaks WHERE profile_id = ?`, profileID)
	var (
		out         ProfileBodyBreaks
		enabled     int
		reasonsJSON string
		updatedAt   int64
	)
	err := row.Scan(&out.ProfileID, &enabled, &out.PlayMinutes, &out.BreakMinutes,
		&out.VoiceMessageTemplate, &reasonsJSON, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return &ProfileBodyBreaks{
			ProfileID:            profileID,
			Enabled:              false,
			PlayMinutes:          30,
			BreakMinutes:         5,
			VoiceMessageTemplate: "Time for a break. {reason}",
			Reasons: []string{
				"Go grab a glass of water.",
				"Stand up and stretch.",
				"Take a quick bathroom break.",
				"Grab a healthy snack.",
			},
		}, nil
	}
	if err != nil {
		return nil, err
	}
	out.Enabled = enabled != 0
	if reasonsJSON != "" {
		_ = json.Unmarshal([]byte(reasonsJSON), &out.Reasons)
	}
	out.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return &out, nil
}

// UpsertProfileBodyBreaks writes or updates the profile config.
func (s *Store) UpsertProfileBodyBreaks(ctx context.Context, p ProfileBodyBreaks) error {
	if p.ProfileID <= 0 {
		return errors.New("profileID required")
	}
	if p.PlayMinutes < 1 || p.PlayMinutes > 240 {
		return fmt.Errorf("play_minutes %d out of range", p.PlayMinutes)
	}
	if p.BreakMinutes < 1 || p.BreakMinutes > 60 {
		return fmt.Errorf("break_minutes %d out of range", p.BreakMinutes)
	}
	if p.VoiceMessageTemplate == "" {
		p.VoiceMessageTemplate = "Time for a break. {reason}"
	}
	if len(p.Reasons) == 0 {
		p.Reasons = []string{defaultBreakReason}
	}
	enabled := 0
	if p.Enabled {
		enabled = 1
	}
	reasonsJSON, _ := json.Marshal(p.Reasons)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO profile_body_breaks
		    (profile_id, enabled, play_minutes, break_minutes,
		     voice_message_template, reasons_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(profile_id) DO UPDATE SET
		    enabled = excluded.enabled,
		    play_minutes = excluded.play_minutes,
		    break_minutes = excluded.break_minutes,
		    voice_message_template = excluded.voice_message_template,
		    reasons_json = excluded.reasons_json,
		    updated_at = excluded.updated_at`,
		p.ProfileID, enabled, p.PlayMinutes, p.BreakMinutes,
		p.VoiceMessageTemplate, string(reasonsJSON), time.Now().Unix())
	return err
}

// RecordPlayActivity is the side-effect called from the kids playback
// progress endpoint. Same cadence as RecordPlaybackProgress; it's
// safe to call both for each progress report.
//
// Behaviors:
//   - Currently on break: accumulator unchanged, just bumps
//     last_updated_at.
//   - Active playback: accumulator increases by the elapsed wall time.
//   - Paused playback or no-progress event: accumulator decays at the
//     same rate (1x decay; matches the spec).
//   - Cross-content swap (new series id, or item id with no series):
//     reset to zero before applying the active-playback delta. Same
//     series, different episode does NOT reset.
func (s *Store) RecordPlayActivity(ctx context.Context, kidID int64, itemID, seriesID string, paused bool, now time.Time) error {
	if kidID <= 0 {
		return errors.New("kidID required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	row := tx.QueryRowContext(ctx, `
		SELECT accumulator_seconds, last_updated_at,
		       COALESCE(current_item_id, ''), COALESCE(current_series_id, ''),
		       on_break_until
		FROM kid_body_break_state WHERE kid_id = ?`, kidID)
	var (
		accSec       float64
		lastUpdated  int64
		curItem      string
		curSeries    string
		onBreakUntil sql.NullInt64
	)
	if err := row.Scan(&accSec, &lastUpdated, &curItem, &curSeries, &onBreakUntil); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		// First progress: insert.
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO kid_body_break_state (kid_id, accumulator_seconds,
			    last_updated_at, current_item_id, current_series_id)
			VALUES (?, 0, ?, ?, ?)`,
			kidID, now.Unix(), itemID, seriesID); err != nil {
			return err
		}
		return tx.Commit()
	}

	// On break: keep state but advance last_updated_at so next report
	// has a clean delta.
	if onBreakUntil.Valid {
		if _, err := tx.ExecContext(ctx,
			`UPDATE kid_body_break_state SET last_updated_at = ? WHERE kid_id = ?`,
			now.Unix(), kidID); err != nil {
			return err
		}
		return tx.Commit()
	}

	elapsed := now.Sub(time.Unix(lastUpdated, 0))
	if elapsed < 0 {
		elapsed = 0
	}
	// Cross-content swap detection.
	contentChanged := false
	if seriesID != "" && curSeries != "" && seriesID != curSeries {
		contentChanged = true
	}
	if seriesID == "" && curSeries == "" && itemID != curItem && curItem != "" {
		contentChanged = true
	}
	if contentChanged {
		accSec = 0
	}
	if !paused {
		accSec += elapsed.Seconds()
	} else {
		accSec -= elapsed.Seconds()
		if accSec < 0 {
			accSec = 0
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE kid_body_break_state SET accumulator_seconds = ?, last_updated_at = ?,
		       current_item_id = ?, current_series_id = ? WHERE kid_id = ?`,
		accSec, now.Unix(), itemID, seriesID, kidID); err != nil {
		return err
	}
	return tx.Commit()
}

// GetBodyBreakStatus returns the rendered state. Triggers a break if
// the accumulator is past the threshold and we're not already on
// break.
func (s *Store) GetBodyBreakStatus(ctx context.Context, kidID, profileID int64, now time.Time) (*BodyBreakStatus, error) {
	cfg, err := s.GetProfileBodyBreaks(ctx, profileID)
	if err != nil {
		return nil, err
	}
	out := &BodyBreakStatus{
		Enabled:      cfg.Enabled,
		PlayMinutes:  cfg.PlayMinutes,
		BreakMinutes: cfg.BreakMinutes,
	}
	if !cfg.Enabled {
		return out, nil
	}

	row := s.db.QueryRowContext(ctx, `
		SELECT accumulator_seconds, on_break_until, COALESCE(on_break_reason, '')
		FROM kid_body_break_state WHERE kid_id = ?`, kidID)
	var (
		accSec       float64
		onBreakUntil sql.NullInt64
		reason       string
	)
	err = row.Scan(&accSec, &onBreakUntil, &reason)
	if errors.Is(err, sql.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	out.AccumulatorMin = accSec / 60.0

	if onBreakUntil.Valid {
		t := time.Unix(onBreakUntil.Int64, 0).UTC()
		if now.Before(t) {
			out.OnBreak = true
			out.OnBreakUntil = t
			out.OnBreakReason = reason
			out.VoiceMessage = renderVoice(cfg.VoiceMessageTemplate, reason)
			return out, nil
		}
		// Break expired naturally: clear and continue.
		_, _ = s.db.ExecContext(ctx, `
			UPDATE kid_body_break_state SET on_break_until = NULL,
			       on_break_reason = NULL, last_break_at = ?, accumulator_seconds = 0
			WHERE kid_id = ?`, now.Unix(), kidID)
	}

	// Should we trigger a break right now?
	if accSec >= float64(cfg.PlayMinutes)*60 {
		st, err := s.StartBreak(ctx, kidID, profileID, now)
		if err != nil {
			return nil, err
		}
		return st, nil
	}
	return out, nil
}

// StartBreak puts the kid on a break for break_minutes, picks a
// random reason from the profile's list, and writes it to the kid
// state row.
func (s *Store) StartBreak(ctx context.Context, kidID, profileID int64, now time.Time) (*BodyBreakStatus, error) {
	cfg, err := s.GetProfileBodyBreaks(ctx, profileID)
	if err != nil {
		return nil, err
	}
	reason := defaultBreakReason
	if len(cfg.Reasons) > 0 {
		reason = cfg.Reasons[rand.Intn(len(cfg.Reasons))]
	}
	endsAt := now.Add(time.Duration(cfg.BreakMinutes) * time.Minute)
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO kid_body_break_state (kid_id, accumulator_seconds, last_updated_at,
		     on_break_until, on_break_reason)
		VALUES (?, 0, ?, ?, ?)
		ON CONFLICT(kid_id) DO UPDATE SET
		    on_break_until = excluded.on_break_until,
		    on_break_reason = excluded.on_break_reason,
		    last_updated_at = excluded.last_updated_at,
		    accumulator_seconds = 0`,
		kidID, now.Unix(), endsAt.Unix(), reason)
	if err != nil {
		return nil, err
	}
	return &BodyBreakStatus{
		Enabled:       true,
		PlayMinutes:   cfg.PlayMinutes,
		BreakMinutes:  cfg.BreakMinutes,
		OnBreak:       true,
		OnBreakUntil:  endsAt,
		OnBreakReason: reason,
		VoiceMessage:  renderVoice(cfg.VoiceMessageTemplate, reason),
	}, nil
}

// EndBreak ends the current break early. ViaOverride records that the
// parent skipped the break (audit log lives in override_actions).
func (s *Store) EndBreak(ctx context.Context, kidID int64, now time.Time, viaOverride bool) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE kid_body_break_state
		SET on_break_until = NULL, on_break_reason = NULL,
		    last_break_at = ?, accumulator_seconds = 0,
		    last_updated_at = ?
		WHERE kid_id = ?`, now.Unix(), now.Unix(), kidID)
	_ = viaOverride
	return err
}

func renderVoice(template, reason string) string {
	if reason == "" {
		reason = defaultBreakReason
	}
	return strings.ReplaceAll(template, "{reason}", reason)
}

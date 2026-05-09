package curation

// Time-based modes (M13). Per-profile modes that override M6/M10/M12
// settings during a scheduled time window. One mode active at a
// time; alphabetical-name priority on overlap. Schedule supports
// midnight wrap (start_time > end_time means the window crosses
// midnight to the next day).

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"
)

type Mode struct {
	ID                int64  `json:"id"`
	ProfileID         int64  `json:"profileId"`
	Name              string `json:"name"`
	ScheduleDays      int    `json:"scheduleDays"` // bitmask: bit 0 = Mon ... bit 6 = Sun
	ScheduleStartTime string `json:"scheduleStartTime"`
	ScheduleEndTime   string `json:"scheduleEndTime"`
	TagFiltersJSON    string `json:"tagFiltersJson,omitempty"`
	// RequiredTagIDs: when non-empty, items must carry at least one
	// of these tags to be visible during the mode. Stored as a JSON
	// array of integers. Empty array = no extra tag requirement.
	RequiredTagIDs []int64 `json:"requiredTagIds"`
	TimeLimitsJSON string  `json:"timeLimitsJson,omitempty"`
	// DimPercent / WarmTintPercent: viewing-effect overrides applied
	// while the mode is active. 0 means "no change."
	DimPercent      int `json:"dimPercent"`
	WarmTintPercent int `json:"warmTintPercent"`
	// LayoutID: optional layout override used while the mode is
	// active. nil / 0 = use the profile's normal layout.
	LayoutID          *int64    `json:"layoutId,omitempty"`
	ThemeKey          string    `json:"themeKey"`
	EnterVoiceMessage string    `json:"enterVoiceMessage,omitempty"`
	ExitVoiceMessage  string    `json:"exitVoiceMessage,omitempty"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type ActiveMode struct {
	Mode              *Mode     `json:"mode,omitempty"`
	Source            string    `json:"source"` // "schedule" | "override" | "none"
	OverrideExpiresAt time.Time `json:"overrideExpiresAt,omitempty"`
}

func (s *Store) ListModes(ctx context.Context, profileID int64) ([]Mode, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, profile_id, name, schedule_days, schedule_start_time,
		       schedule_end_time, tag_filters_json, COALESCE(time_limits_json, ''),
		       dim_percent, warm_tint_percent, theme_key,
		       COALESCE(enter_voice_message, ''), COALESCE(exit_voice_message, ''),
		       layout_id, required_tag_ids_json, created_at, updated_at
		FROM profile_modes WHERE profile_id = ? ORDER BY name COLLATE NOCASE`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Mode
	for rows.Next() {
		m, err := scanMode(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

func (s *Store) GetMode(ctx context.Context, id int64) (*Mode, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, profile_id, name, schedule_days, schedule_start_time,
		       schedule_end_time, tag_filters_json, COALESCE(time_limits_json, ''),
		       dim_percent, warm_tint_percent, theme_key,
		       COALESCE(enter_voice_message, ''), COALESCE(exit_voice_message, ''),
		       layout_id, required_tag_ids_json, created_at, updated_at
		FROM profile_modes WHERE id = ?`, id)
	m, err := scanMode(row.Scan)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, sql.ErrNoRows
		}
		return nil, err
	}
	return m, nil
}

// scanMode pulls a row's columns into a Mode struct. Used by both
// ListModes (rows.Scan) and GetMode (row.Scan).
func scanMode(scan func(...any) error) (*Mode, error) {
	var m Mode
	var ca, ua int64
	var layoutID sql.NullInt64
	var reqTagsJSON string
	if err := scan(&m.ID, &m.ProfileID, &m.Name, &m.ScheduleDays,
		&m.ScheduleStartTime, &m.ScheduleEndTime, &m.TagFiltersJSON,
		&m.TimeLimitsJSON, &m.DimPercent, &m.WarmTintPercent, &m.ThemeKey,
		&m.EnterVoiceMessage, &m.ExitVoiceMessage, &layoutID,
		&reqTagsJSON, &ca, &ua); err != nil {
		return nil, err
	}
	m.CreatedAt = unixToTime(ca)
	m.UpdatedAt = unixToTime(ua)
	if layoutID.Valid {
		v := layoutID.Int64
		m.LayoutID = &v
	}
	m.RequiredTagIDs = []int64{}
	if reqTagsJSON != "" {
		_ = json.Unmarshal([]byte(reqTagsJSON), &m.RequiredTagIDs)
	}
	if m.RequiredTagIDs == nil {
		m.RequiredTagIDs = []int64{}
	}
	return &m, nil
}

func (s *Store) CreateMode(ctx context.Context, m Mode) (*Mode, error) {
	if m.ProfileID <= 0 || m.Name == "" {
		return nil, errors.New("profileID + name required")
	}
	if !validHHMM(m.ScheduleStartTime) || !validHHMM(m.ScheduleEndTime) {
		return nil, fmt.Errorf("schedule times must be HH:MM")
	}
	if m.ThemeKey == "" {
		m.ThemeKey = "default"
	}
	if m.TagFiltersJSON == "" {
		m.TagFiltersJSON = "[]"
	}
	requiredTagsJSON := encodeIntArray(m.RequiredTagIDs)
	var layoutID any
	if m.LayoutID != nil && *m.LayoutID > 0 {
		layoutID = *m.LayoutID
	}
	now := time.Now().UTC().Unix()
	if err := validateModeViewing(m); err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO profile_modes
		    (profile_id, name, schedule_days, schedule_start_time,
		     schedule_end_time, tag_filters_json, time_limits_json,
		     dim_percent, warm_tint_percent, theme_key, enter_voice_message,
		     exit_voice_message, layout_id, required_tag_ids_json,
		     created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ProfileID, m.Name, m.ScheduleDays, m.ScheduleStartTime,
		m.ScheduleEndTime, m.TagFiltersJSON,
		nullableString(m.TimeLimitsJSON), m.DimPercent, m.WarmTintPercent,
		m.ThemeKey, nullableString(m.EnterVoiceMessage),
		nullableString(m.ExitVoiceMessage), layoutID, requiredTagsJSON,
		now, now)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetMode(ctx, id)
}

func (s *Store) UpdateMode(ctx context.Context, id int64, m Mode) (*Mode, error) {
	if !validHHMM(m.ScheduleStartTime) || !validHHMM(m.ScheduleEndTime) {
		return nil, fmt.Errorf("schedule times must be HH:MM")
	}
	if m.ThemeKey == "" {
		m.ThemeKey = "default"
	}
	if m.TagFiltersJSON == "" {
		m.TagFiltersJSON = "[]"
	}
	requiredTagsJSON := encodeIntArray(m.RequiredTagIDs)
	var layoutID any
	if m.LayoutID != nil && *m.LayoutID > 0 {
		layoutID = *m.LayoutID
	}
	now := time.Now().UTC().Unix()
	if err := validateModeViewing(m); err != nil {
		return nil, err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE profile_modes SET
		    name = ?, schedule_days = ?, schedule_start_time = ?,
		    schedule_end_time = ?, tag_filters_json = ?,
		    time_limits_json = ?, dim_percent = ?, warm_tint_percent = ?,
		    theme_key = ?, enter_voice_message = ?,
		    exit_voice_message = ?, layout_id = ?,
		    required_tag_ids_json = ?, updated_at = ?
		WHERE id = ?`,
		m.Name, m.ScheduleDays, m.ScheduleStartTime, m.ScheduleEndTime,
		m.TagFiltersJSON, nullableString(m.TimeLimitsJSON),
		m.DimPercent, m.WarmTintPercent, m.ThemeKey,
		nullableString(m.EnterVoiceMessage), nullableString(m.ExitVoiceMessage),
		layoutID, requiredTagsJSON, now, id)
	if err != nil {
		return nil, err
	}
	return s.GetMode(ctx, id)
}

func validateModeViewing(m Mode) error {
	if m.DimPercent < 0 || m.DimPercent > 80 {
		return fmt.Errorf("dimPercent %d out of range (0-80)", m.DimPercent)
	}
	if m.WarmTintPercent < 0 || m.WarmTintPercent > 100 {
		return fmt.Errorf("warmTintPercent %d out of range (0-100)", m.WarmTintPercent)
	}
	return nil
}

func encodeIntArray(ids []int64) string {
	if ids == nil {
		ids = []int64{}
	}
	b, _ := json.Marshal(ids)
	return string(b)
}

func (s *Store) DeleteMode(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM profile_modes WHERE id = ?`, id)
	return err
}

// ResolveActiveMode picks the active mode for the given kid + clock.
// Override (when present + unexpired) wins; otherwise the
// alphabetically-first mode whose schedule contains `now`.
func (s *Store) ResolveActiveMode(ctx context.Context, kidID int64, profileID int64, now time.Time) (*ActiveMode, error) {
	// Check override first.
	row := s.db.QueryRowContext(ctx, `
		SELECT override_mode_id, override_mode_until
		FROM kid_mode_state WHERE kid_id = ?`, kidID)
	var (
		ovID    sql.NullInt64
		ovUntil sql.NullInt64
	)
	if err := row.Scan(&ovID, &ovUntil); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if ovID.Valid && ovUntil.Valid && now.Unix() < ovUntil.Int64 {
		mode, err := s.GetMode(ctx, ovID.Int64)
		if err != nil {
			return nil, err
		}
		return &ActiveMode{
			Mode:              mode,
			Source:            "override",
			OverrideExpiresAt: unixToTime(ovUntil.Int64),
		}, nil
	}

	modes, err := s.ListModes(ctx, profileID)
	if err != nil {
		return nil, err
	}
	candidates := make([]Mode, 0, len(modes))
	for _, m := range modes {
		if m.ScheduleDays == 0 {
			continue
		}
		if scheduleContains(m, now) {
			candidates = append(candidates, m)
		}
	}
	if len(candidates) == 0 {
		return &ActiveMode{Source: "none"}, nil
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Name < candidates[j].Name
	})
	chosen := candidates[0]
	return &ActiveMode{Mode: &chosen, Source: "schedule"}, nil
}

// SetModeOverride forces a mode (or "no mode" via id == 0) for a TTL.
func (s *Store) SetModeOverride(ctx context.Context, kidID, modeID int64, until time.Time) error {
	now := time.Now().UTC().Unix()
	var modeNullable any
	if modeID > 0 {
		modeNullable = modeID
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO kid_mode_state (kid_id, override_mode_id, override_mode_until, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(kid_id) DO UPDATE SET
		    override_mode_id = excluded.override_mode_id,
		    override_mode_until = excluded.override_mode_until,
		    updated_at = excluded.updated_at`,
		kidID, modeNullable, until.Unix(), now)
	return err
}

func (s *Store) ClearModeOverride(ctx context.Context, kidID int64) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE kid_mode_state SET override_mode_id = NULL,
		       override_mode_until = NULL, updated_at = ? WHERE kid_id = ?`,
		time.Now().UTC().Unix(), kidID)
	return err
}

// scheduleContains: does mode.schedule cover `now`? Day-of-week and
// start/end time. Wraps midnight when end < start.
func scheduleContains(m Mode, now time.Time) bool {
	wd := int(now.Weekday())
	// Mon=1, Tue=2, ..., Sun=0 in Go; reorder so Mon=bit0.
	day := (wd + 6) % 7 // Mon=0, Sun=6
	if m.ScheduleDays&(1<<day) == 0 {
		return false
	}
	startH, startM, _ := parseHHMM(m.ScheduleStartTime)
	endH, endM, _ := parseHHMM(m.ScheduleEndTime)
	startMin := startH*60 + startM
	endMin := endH*60 + endM
	curMin := now.Hour()*60 + now.Minute()
	if startMin <= endMin {
		return curMin >= startMin && curMin < endMin
	}
	// Midnight wrap: window is [start, 24h) U [0, end).
	return curMin >= startMin || curMin < endMin
}

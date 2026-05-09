package curation

// Time limits (M10). Per-profile daily bucket with admin-tunable
// refill cadence + day-start anchor, plus optional per-show daily
// cap and per-movie daily-starts cap. Override grants temporarily
// lift the bucket; segments derived from playback reports are the
// only source of consumption.
//
// The bucket math is deterministic given (now, profile_time_limits,
// segments, grants). It does NOT mutate state on read; segment writes
// happen on playback-progress reports, grants are written by the
// override flow. ComputeTimeStatus is cheap enough to call per
// page-load + every 60s while a kid is in the SPA.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Sentinel for an "unlimited" override on per-content caps. Stored as
// -1 in the database so NULL retains the "inherit profile defaults"
// meaning.
const UnlimitedOverride = -1

// ProfileTimeLimits is the per-profile config row. Defaults match the
// migration: enabled=false, 240 min/day, 1h refill, 2 AM start, no
// per-show / per-movie caps.
type ProfileTimeLimits struct {
	ProfileID             int64     `json:"profileId"`
	Enabled               bool      `json:"enabled"`
	DailyCapMinutes       int       `json:"dailyCapMinutes"`
	RefillIntervalHours   int       `json:"refillIntervalHours"`
	DayStartHour          int       `json:"dayStartHour"`
	DefaultShowCapMinutes *int      `json:"defaultShowCapMinutes,omitempty"`
	DefaultMovieStarts    *int      `json:"defaultMovieStarts,omitempty"`
	UpdatedAt             time.Time `json:"updatedAt"`
}

// ContentTimeOverride is the per-(profile, item) override row.
// OverrideCapMinutes / OverrideStarts of -1 means "unlimited"; nil
// means "inherit the profile default."
type ContentTimeOverride struct {
	ProfileID          int64     `json:"profileId"`
	JellyfinItemID     string    `json:"jellyfinItemId"`
	OverrideCapMinutes *int      `json:"overrideCapMinutes,omitempty"`
	OverrideStarts     *int      `json:"overrideStarts,omitempty"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

// WatchSegment is one closed playback span attributed to a kid. Used
// for usage accounting and (future) admin audit views.
type WatchSegment struct {
	ID             int64
	KidID          int64
	JellyfinItemID string
	SeriesID       string
	StartedAt      time.Time
	EndedAt        time.Time
	MinutesWatched float64
	DayBucket      string
}

// TimeGrant is one override-granted bonus. Scope is 'global' (lifts
// the daily cap), 'item' (only for that item id), or 'series' (only
// for episodes of that series id). MinutesGranted is the number of
// minutes added; ExpiresAt is when the grant stops counting (nil =
// "until next day reset").
type TimeGrant struct {
	ID             int64
	KidID          int64
	GrantedAt      time.Time
	GrantedBy      string
	MinutesGranted *int
	ExpiresAt      *time.Time
	Scope          string
	ScopeID        string
}

// BucketStatus is the rendered state of one bucket (global, per-show,
// or per-movie). AvailableMinutes can be negative briefly if a kid
// kept watching past the cap before the segment ledger caught up;
// callers should clamp at zero for display.
type BucketStatus struct {
	AvailableMinutes float64   `json:"availableMinutes"`
	CapMinutes       int       `json:"capMinutes"`
	NextRefillAt     time.Time `json:"nextRefillAt"`
	NextResetAt      time.Time `json:"nextResetAt"`
	Locked           bool      `json:"locked"`
	Reason           string    `json:"reason,omitempty"`
}

// MovieStatus differs from BucketStatus: per-movie limits are counted
// in starts, not minutes.
type MovieStatus struct {
	StartsToday   int       `json:"startsToday"`
	StartsAllowed int       `json:"startsAllowed"`
	NextResetAt   time.Time `json:"nextResetAt"`
	Locked        bool      `json:"locked"`
	Reason        string    `json:"reason,omitempty"`
}

// TimeStatus is the full rendered state for a kid.
type TimeStatus struct {
	Enabled  bool                    `json:"enabled"`
	Global   BucketStatus            `json:"global"`
	PerShow  map[string]BucketStatus `json:"perShow"`
	PerMovie map[string]MovieStatus  `json:"perMovie"`
}

// CanPlayResult is the outcome of a pre-play check.
type CanPlayResult struct {
	Allowed          bool    `json:"canPlay"`
	Reason           string  `json:"reason,omitempty"`
	AvailableMinutes float64 `json:"availableMinutes,omitempty"`
}

// GetProfileTimeLimits returns the row for a profile, falling back to
// the migration defaults if no row exists yet (we don't auto-seed on
// profile creation - admins enable it explicitly).
func (s *Store) GetProfileTimeLimits(ctx context.Context, profileID int64) (*ProfileTimeLimits, error) {
	defaults := &ProfileTimeLimits{
		ProfileID:           profileID,
		Enabled:             false,
		DailyCapMinutes:     240,
		RefillIntervalHours: 1,
		DayStartHour:        2,
	}
	return loadOrDefault(ctx, s.db, `
		SELECT profile_id, enabled, daily_cap_minutes, refill_interval_hours,
		       day_start_hour, default_show_cap_minutes, default_movie_starts,
		       updated_at
		FROM profile_time_limits WHERE profile_id = ?`, profileID,
		func(row *sql.Row) (*ProfileTimeLimits, error) {
			var (
				out      ProfileTimeLimits
				enabled  int
				showCap  sql.NullInt64
				movieCap sql.NullInt64
				updated  int64
			)
			if err := row.Scan(&out.ProfileID, &enabled, &out.DailyCapMinutes,
				&out.RefillIntervalHours, &out.DayStartHour, &showCap, &movieCap, &updated); err != nil {
				return nil, err
			}
			out.Enabled = enabled != 0
			if showCap.Valid {
				v := int(showCap.Int64)
				out.DefaultShowCapMinutes = &v
			}
			if movieCap.Valid {
				v := int(movieCap.Int64)
				out.DefaultMovieStarts = &v
			}
			out.UpdatedAt = unixToTime(updated)
			return &out, nil
		}, defaults)
}

// UpsertProfileTimeLimits writes / updates the profile config. The
// caller is responsible for validating ranges; we re-check critical
// invariants here (refill_interval must be one of {1,4,12,24}, etc.)
// because the SQL CHECK constraint catches the same thing but with
// less friendly error text.
func (s *Store) UpsertProfileTimeLimits(ctx context.Context, p ProfileTimeLimits) error {
	if p.ProfileID <= 0 {
		return errors.New("profileID required")
	}
	if p.DailyCapMinutes < 0 || p.DailyCapMinutes > 24*60 {
		return fmt.Errorf("daily_cap_minutes %d out of range", p.DailyCapMinutes)
	}
	switch p.RefillIntervalHours {
	case 1, 4, 12, 24:
	default:
		return fmt.Errorf("refill_interval_hours must be 1/4/12/24, got %d", p.RefillIntervalHours)
	}
	if p.DayStartHour < 0 || p.DayStartHour > 23 {
		return fmt.Errorf("day_start_hour %d out of range", p.DayStartHour)
	}
	now := time.Now().Unix()
	enabled := 0
	if p.Enabled {
		enabled = 1
	}
	var showCap, movieCap any
	if p.DefaultShowCapMinutes != nil {
		showCap = *p.DefaultShowCapMinutes
	}
	if p.DefaultMovieStarts != nil {
		movieCap = *p.DefaultMovieStarts
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO profile_time_limits
		    (profile_id, enabled, daily_cap_minutes, refill_interval_hours,
		     day_start_hour, default_show_cap_minutes, default_movie_starts,
		     updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(profile_id) DO UPDATE SET
		    enabled                 = excluded.enabled,
		    daily_cap_minutes       = excluded.daily_cap_minutes,
		    refill_interval_hours   = excluded.refill_interval_hours,
		    day_start_hour          = excluded.day_start_hour,
		    default_show_cap_minutes = excluded.default_show_cap_minutes,
		    default_movie_starts    = excluded.default_movie_starts,
		    updated_at              = excluded.updated_at`,
		p.ProfileID, enabled, p.DailyCapMinutes, p.RefillIntervalHours,
		p.DayStartHour, showCap, movieCap, now)
	return err
}

// ListContentOverrides returns all per-item overrides for a profile.
func (s *Store) ListContentOverrides(ctx context.Context, profileID int64) ([]ContentTimeOverride, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT profile_id, jellyfin_item_id, override_cap_minutes, override_starts, updated_at
		FROM content_time_overrides WHERE profile_id = ? ORDER BY jellyfin_item_id`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ContentTimeOverride
	for rows.Next() {
		var (
			o        ContentTimeOverride
			capMin   sql.NullInt64
			startsN  sql.NullInt64
			updated  int64
		)
		if err := rows.Scan(&o.ProfileID, &o.JellyfinItemID, &capMin, &startsN, &updated); err != nil {
			return nil, err
		}
		if capMin.Valid {
			v := int(capMin.Int64)
			o.OverrideCapMinutes = &v
		}
		if startsN.Valid {
			v := int(startsN.Int64)
			o.OverrideStarts = &v
		}
		o.UpdatedAt = unixToTime(updated)
		out = append(out, o)
	}
	return out, rows.Err()
}

// UpsertContentOverride writes / updates a per-item override. Pass
// both override fields nil to clear the row (caller can use
// DeleteContentOverride for that explicitly; this just deletes when
// both are nil for ergonomics).
func (s *Store) UpsertContentOverride(ctx context.Context, o ContentTimeOverride) error {
	if o.ProfileID <= 0 || o.JellyfinItemID == "" {
		return errors.New("profileID + itemID required")
	}
	if o.OverrideCapMinutes == nil && o.OverrideStarts == nil {
		_, err := s.db.ExecContext(ctx,
			`DELETE FROM content_time_overrides WHERE profile_id = ? AND jellyfin_item_id = ?`,
			o.ProfileID, o.JellyfinItemID)
		return err
	}
	now := time.Now().Unix()
	var capMin, startsN any
	if o.OverrideCapMinutes != nil {
		capMin = *o.OverrideCapMinutes
	}
	if o.OverrideStarts != nil {
		startsN = *o.OverrideStarts
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO content_time_overrides
		    (profile_id, jellyfin_item_id, override_cap_minutes, override_starts, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(profile_id, jellyfin_item_id) DO UPDATE SET
		    override_cap_minutes = excluded.override_cap_minutes,
		    override_starts      = excluded.override_starts,
		    updated_at           = excluded.updated_at`,
		o.ProfileID, o.JellyfinItemID, capMin, startsN, now)
	return err
}

// staleSegmentThreshold is how long without a progress report before
// we consider an open segment closed (network drop or app crash mid-
// playback). Conservative: we don't want to undercount usage when
// the kid keeps watching during a brief network blip.
const staleSegmentThreshold = 90 * time.Second

// progressGapThreshold is how much wall-clock can pass between two
// progress events on the same item before we treat them as separate
// segments (e.g. kid pauses for a snack, comes back). Anything under
// this window extends the existing segment.
const progressGapThreshold = 30 * time.Second

// RecordPlaybackProgress is the side-effect called from the kids
// playback-progress endpoint. It maintains exactly one open segment
// per kid; switching items closes the old segment automatically.
func (s *Store) RecordPlaybackProgress(ctx context.Context, kidID int64, profileID int64, itemID, seriesID string, paused bool, now time.Time) error {
	if kidID <= 0 || itemID == "" {
		return errors.New("kidID + itemID required")
	}
	limits, err := s.GetProfileTimeLimits(ctx, profileID)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Look up current open segment.
	var (
		segID            int64
		curItemID        string
		curStartedAt     int64
		curEndedAt       int64
		curMinutes       float64
		lastProgressAt   int64
	)
	row := tx.QueryRowContext(ctx, `
		SELECT s.id, s.jellyfin_item_id, s.started_at, s.ended_at,
		       s.minutes_watched, o.last_progress_at
		FROM kid_open_segments o
		JOIN kid_watch_segments s ON s.id = o.segment_id
		WHERE o.kid_id = ?`, kidID)
	openErr := row.Scan(&segID, &curItemID, &curStartedAt, &curEndedAt, &curMinutes, &lastProgressAt)
	hasOpen := openErr == nil
	if openErr != nil && !errors.Is(openErr, sql.ErrNoRows) {
		return openErr
	}

	// Paused reports don't extend the segment - they pin its end at
	// the last unpaused frame and become the trigger for "if no more
	// reports come in, this is the close moment."
	if hasOpen && (paused || curItemID != itemID || now.Sub(time.Unix(lastProgressAt, 0)) > progressGapThreshold) {
		// Close current segment, open new only if !paused + same kid.
		if _, err := tx.ExecContext(ctx, `DELETE FROM kid_open_segments WHERE kid_id = ?`, kidID); err != nil {
			return err
		}
		hasOpen = false
		if paused {
			return tx.Commit()
		}
	}

	if hasOpen {
		// Extend the existing segment.
		newEnd := now.Unix()
		newMinutes := curMinutes + float64(newEnd-curEndedAt)/60.0
		if _, err := tx.ExecContext(ctx, `
			UPDATE kid_watch_segments SET ended_at = ?, minutes_watched = ? WHERE id = ?`,
			newEnd, newMinutes, segID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE kid_open_segments SET last_progress_at = ? WHERE kid_id = ?`,
			newEnd, kidID); err != nil {
			return err
		}
		return tx.Commit()
	}

	// Open a new segment when not paused.
	if paused {
		return tx.Commit()
	}
	bucket := dayBucket(now, limits.DayStartHour)
	res, err := tx.ExecContext(ctx, `
		INSERT INTO kid_watch_segments
		    (kid_id, jellyfin_item_id, series_id, started_at, ended_at, minutes_watched, day_bucket)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		kidID, itemID, nullableString(seriesID), now.Unix(), now.Unix(), 0.0, bucket)
	if err != nil {
		return err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT OR REPLACE INTO kid_open_segments (kid_id, segment_id, last_progress_at)
		VALUES (?, ?, ?)`, kidID, id, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// CloseStaleSegments closes any open segment whose last progress
// report is older than staleSegmentThreshold. Safe to call frequently;
// it's a single indexed delete.
func (s *Store) CloseStaleSegments(ctx context.Context, now time.Time) error {
	cutoff := now.Add(-staleSegmentThreshold).Unix()
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM kid_open_segments WHERE last_progress_at < ?`, cutoff)
	return err
}

// CreateGrant adds a time grant. Returns the row id so the caller can
// reference it in audit logs.
func (s *Store) CreateGrant(ctx context.Context, g TimeGrant) (int64, error) {
	if g.KidID <= 0 || g.GrantedBy == "" || g.Scope == "" {
		return 0, errors.New("kidID + grantedBy + scope required")
	}
	switch g.Scope {
	case "global", "item", "series":
	default:
		return 0, fmt.Errorf("invalid scope %q", g.Scope)
	}
	if g.Scope != "global" && g.ScopeID == "" {
		return 0, errors.New("scopeID required for non-global grants")
	}
	if g.GrantedAt.IsZero() {
		g.GrantedAt = time.Now().UTC()
	}
	var minutes, expires any
	if g.MinutesGranted != nil {
		minutes = *g.MinutesGranted
	}
	if g.ExpiresAt != nil {
		expires = g.ExpiresAt.Unix()
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO kid_time_grants
		    (kid_id, granted_at, granted_by, minutes_granted, expires_at, scope, scope_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		g.KidID, g.GrantedAt.Unix(), g.GrantedBy, minutes, expires, g.Scope,
		nullableString(g.ScopeID))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// activeGrants returns all grants for a kid that count against the
// given context (now + scope). For "until next reset" grants
// (ExpiresAt nil), the implicit expiry is the next NextResetAt; we
// pass that in as `dayResetAt` so the caller (ComputeTimeStatus) can
// use a single anchored time.
func (s *Store) activeGrants(ctx context.Context, kidID int64, now time.Time, dayResetAt time.Time) ([]TimeGrant, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, kid_id, granted_at, granted_by, minutes_granted, expires_at, scope, scope_id
		FROM kid_time_grants WHERE kid_id = ? ORDER BY granted_at`, kidID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TimeGrant
	for rows.Next() {
		var (
			g          TimeGrant
			minutes    sql.NullInt64
			expires    sql.NullInt64
			scopeID    sql.NullString
		)
		var grantedAt int64
		if err := rows.Scan(&g.ID, &g.KidID, &grantedAt, &g.GrantedBy, &minutes, &expires, &g.Scope, &scopeID); err != nil {
			return nil, err
		}
		g.GrantedAt = unixToTime(grantedAt)
		if minutes.Valid {
			v := int(minutes.Int64)
			g.MinutesGranted = &v
		}
		if expires.Valid {
			t := unixToTime(expires.Int64)
			g.ExpiresAt = &t
		} else {
			// Implicit: until next day reset.
			t := dayResetAt
			g.ExpiresAt = &t
		}
		g.ScopeID = scanNullableString(scopeID)
		// Filter expired.
		if g.ExpiresAt != nil && now.After(*g.ExpiresAt) {
			continue
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// ComputeTimeStatus is the read path. Pure function of stored state +
// clock.
func (s *Store) ComputeTimeStatus(ctx context.Context, kidID, profileID int64, now time.Time, perItemIDs []string, perSeriesIDs []string) (*TimeStatus, error) {
	limits, err := s.GetProfileTimeLimits(ctx, profileID)
	if err != nil {
		return nil, err
	}
	if !limits.Enabled {
		// Disabled = "unlimited everything." Returning a stub keeps
		// the caller's render path uniform.
		return &TimeStatus{
			Enabled: false,
			Global:  BucketStatus{AvailableMinutes: float64(24 * 60), CapMinutes: 24 * 60, NextRefillAt: now, NextResetAt: now.Add(24 * time.Hour)},
		}, nil
	}

	dayStart := mostRecentDayStart(now, limits.DayStartHour)
	dayReset := dayStart.Add(24 * time.Hour)
	bucket := dayBucket(now, limits.DayStartHour)

	// Refill math: at the day start, bucket == 0; at day end, bucket
	// == cap. Refills happen every refill_interval_hours.
	refillsPerDay := 24 / limits.RefillIntervalHours
	refillStep := float64(limits.DailyCapMinutes) / float64(refillsPerDay)
	elapsed := now.Sub(dayStart)
	refillsSoFar := int(elapsed.Hours()) / limits.RefillIntervalHours
	if refillsSoFar > refillsPerDay {
		refillsSoFar = refillsPerDay
	}
	accrued := float64(refillsSoFar) * refillStep
	if accrued > float64(limits.DailyCapMinutes) {
		accrued = float64(limits.DailyCapMinutes)
	}

	// Usage today.
	usageToday, err := s.minutesWatched(ctx, kidID, bucket, "")
	if err != nil {
		return nil, err
	}

	grants, err := s.activeGrants(ctx, kidID, now, dayReset)
	if err != nil {
		return nil, err
	}
	var globalGrant float64
	for _, g := range grants {
		if g.Scope != "global" {
			continue
		}
		if g.MinutesGranted != nil {
			globalGrant += float64(*g.MinutesGranted)
		}
	}

	available := accrued - usageToday + globalGrant
	if available < 0 {
		available = 0
	}
	nextRefill := dayStart.Add(time.Duration(refillsSoFar+1) * time.Duration(limits.RefillIntervalHours) * time.Hour)
	if nextRefill.After(dayReset) {
		nextRefill = dayReset
	}

	global := BucketStatus{
		AvailableMinutes: available,
		CapMinutes:       limits.DailyCapMinutes,
		NextRefillAt:     nextRefill,
		NextResetAt:      dayReset,
	}
	if available <= 0 {
		global.Locked = true
		global.Reason = "daily limit reached"
	}

	out := &TimeStatus{
		Enabled:  true,
		Global:   global,
		PerShow:  map[string]BucketStatus{},
		PerMovie: map[string]MovieStatus{},
	}

	// Per-show buckets.
	if limits.DefaultShowCapMinutes != nil || hasContentOverrides(ctx, s, profileID) {
		for _, sid := range perSeriesIDs {
			cap := -1
			if limits.DefaultShowCapMinutes != nil {
				cap = *limits.DefaultShowCapMinutes
			}
			// Series-level overrides aren't separately modeled; per-
			// item overrides keyed on the series id can act as the
			// series cap. This keeps the schema simple.
			if v := overrideCap(ctx, s, profileID, sid); v != nil {
				cap = *v
			}
			if cap == UnlimitedOverride || cap < 0 {
				out.PerShow[sid] = BucketStatus{
					AvailableMinutes: float64(24 * 60), CapMinutes: 24 * 60,
					NextRefillAt: dayReset, NextResetAt: dayReset,
				}
				continue
			}
			used, err := s.minutesWatched(ctx, kidID, bucket, sid)
			if err != nil {
				return nil, err
			}
			var seriesGrant float64
			for _, g := range grants {
				if g.Scope == "series" && g.ScopeID == sid && g.MinutesGranted != nil {
					seriesGrant += float64(*g.MinutesGranted)
				}
			}
			avail := float64(cap) - used + seriesGrant
			if avail < 0 {
				avail = 0
			}
			b := BucketStatus{
				AvailableMinutes: avail,
				CapMinutes:       cap,
				NextRefillAt:     dayReset,
				NextResetAt:      dayReset,
			}
			if avail <= 0 {
				b.Locked = true
				b.Reason = "show cap reached"
			}
			out.PerShow[sid] = b
		}
	}

	// Per-movie starts buckets.
	if limits.DefaultMovieStarts != nil || hasContentOverrides(ctx, s, profileID) {
		for _, mid := range perItemIDs {
			startsCap := -1
			if limits.DefaultMovieStarts != nil {
				startsCap = *limits.DefaultMovieStarts
			}
			if v := overrideStarts(ctx, s, profileID, mid); v != nil {
				startsCap = *v
			}
			if startsCap == UnlimitedOverride || startsCap < 0 {
				out.PerMovie[mid] = MovieStatus{StartsAllowed: 1 << 30, NextResetAt: dayReset}
				continue
			}
			starts, err := s.startsToday(ctx, kidID, bucket, mid)
			if err != nil {
				return nil, err
			}
			ms := MovieStatus{StartsToday: starts, StartsAllowed: startsCap, NextResetAt: dayReset}
			if starts >= startsCap {
				ms.Locked = true
				ms.Reason = "movie already played today"
			}
			out.PerMovie[mid] = ms
		}
	}

	return out, nil
}

// CanPlay is the gate for starting a new playback. It applies global
// + (per-show OR per-movie) constraints depending on the item's type.
// `seriesID` is empty for movies.
func (s *Store) CanPlay(ctx context.Context, kidID, profileID int64, itemID, seriesID string, now time.Time) (CanPlayResult, error) {
	limits, err := s.GetProfileTimeLimits(ctx, profileID)
	if err != nil {
		return CanPlayResult{}, err
	}
	if !limits.Enabled {
		return CanPlayResult{Allowed: true}, nil
	}
	perItem := []string{itemID}
	perSeries := []string{}
	if seriesID != "" {
		perSeries = append(perSeries, seriesID)
	}
	st, err := s.ComputeTimeStatus(ctx, kidID, profileID, now, perItem, perSeries)
	if err != nil {
		return CanPlayResult{}, err
	}
	if st.Global.Locked {
		return CanPlayResult{Allowed: false, Reason: st.Global.Reason}, nil
	}
	if seriesID != "" {
		if b, ok := st.PerShow[seriesID]; ok && b.Locked {
			return CanPlayResult{Allowed: false, Reason: b.Reason}, nil
		}
	} else {
		if m, ok := st.PerMovie[itemID]; ok && m.Locked {
			return CanPlayResult{Allowed: false, Reason: m.Reason}, nil
		}
	}
	return CanPlayResult{Allowed: true, AvailableMinutes: st.Global.AvailableMinutes}, nil
}

// minutesWatched sums kid_watch_segments.minutes_watched for a (kid,
// day_bucket, optional seriesID).
func (s *Store) minutesWatched(ctx context.Context, kidID int64, dayBucket, seriesID string) (float64, error) {
	q := `SELECT COALESCE(SUM(minutes_watched), 0) FROM kid_watch_segments WHERE kid_id = ? AND day_bucket = ?`
	args := []any{kidID, dayBucket}
	if seriesID != "" {
		q += ` AND series_id = ?`
		args = append(args, seriesID)
	}
	var sum float64
	if err := s.db.QueryRowContext(ctx, q, args...).Scan(&sum); err != nil {
		return 0, err
	}
	return sum, nil
}

// startsToday counts distinct segments for an item in the day bucket.
// Each "watched once" is one segment open; if the kid restarts a
// movie that's a separate row.
func (s *Store) startsToday(ctx context.Context, kidID int64, dayBucket, itemID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM kid_watch_segments WHERE kid_id = ? AND day_bucket = ? AND jellyfin_item_id = ?`,
		kidID, dayBucket, itemID).Scan(&n)
	return n, err
}

// dayBucket returns the YYYY-MM-DD label that `t` falls in, anchored
// to dayStartHour. e.g. with dayStartHour=2, a watch at 2025-05-04
// 01:30 belongs to the 2025-05-03 bucket.
func dayBucket(t time.Time, dayStartHour int) string {
	anchor := mostRecentDayStart(t, dayStartHour)
	return anchor.Format("2006-01-02")
}

// mostRecentDayStart returns the most recent crossing of dayStartHour.
func mostRecentDayStart(t time.Time, dayStartHour int) time.Time {
	loc := t.Location()
	candidate := time.Date(t.Year(), t.Month(), t.Day(), dayStartHour, 0, 0, 0, loc)
	if candidate.After(t) {
		candidate = candidate.Add(-24 * time.Hour)
	}
	return candidate
}

// hasContentOverrides is a cheap probe so ComputeTimeStatus avoids
// running the per-show / per-movie loops when there's nothing to
// override.
func hasContentOverrides(ctx context.Context, s *Store, profileID int64) bool {
	var n int
	_ = s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM content_time_overrides WHERE profile_id = ?`, profileID).Scan(&n)
	return n > 0
}

// overrideCap returns the cap minutes override for (profile, item)
// or nil if the profile defaults apply.
func overrideCap(ctx context.Context, s *Store, profileID int64, itemID string) *int {
	var v sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT override_cap_minutes FROM content_time_overrides WHERE profile_id = ? AND jellyfin_item_id = ?`,
		profileID, itemID).Scan(&v)
	if err != nil || !v.Valid {
		return nil
	}
	x := int(v.Int64)
	return &x
}

// overrideStarts returns the daily-starts override for (profile, item)
// or nil.
func overrideStarts(ctx context.Context, s *Store, profileID int64, itemID string) *int {
	var v sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT override_starts FROM content_time_overrides WHERE profile_id = ? AND jellyfin_item_id = ?`,
		profileID, itemID).Scan(&v)
	if err != nil || !v.Valid {
		return nil
	}
	x := int(v.Int64)
	return &x
}

// allowedScopes is just exported for the override handler so callers
// reject bad client input the same way the engine would.
var allowedScopes = strings.Split("global,item,series", ",")

func IsValidGrantScope(s string) bool {
	for _, x := range allowedScopes {
		if x == s {
			return true
		}
	}
	return false
}

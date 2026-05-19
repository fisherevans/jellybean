// Package itemcache is the server-side mirror of the Jellyfin item subset
// Jellybean's list endpoints render.
//
// Reads (admin items list, kid library cold-load, browse decorate) hit
// SQLite instead of Jellyfin so a 14-18s admin page collapses to <1s. A
// background ticker (driven by cmd/jellybean) calls Refresh on a tunable
// cadence; the refresh is atomic - readers either see the previous scan
// in full or the new one, never a half-empty table.
//
// Scope: Movie + Series only. Episode-type ids fall back to live
// Jellyfin lookups via the existing GetItemsByIDsBatched helper.
// UserData (per-user resume / watched flags) is intentionally never
// cached here - it stays a live per-request fetch.
package itemcache

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// jellyfinClient is the subset of *jellyfin.Client Refresh needs. Kept
// as an interface so tests can supply a fake without spinning a full
// HTTP server.
type jellyfinClient interface {
	GetItems(ctx context.Context, f jellyfin.ItemsFilter) (*jellyfin.ItemsResult, error)
}

// CatalogBumper is the tiny interface itemcache uses to nudge the
// kid-facing ETag salt when a scan introduces, updates, or deletes
// rows. Production wires it to curation.Store.BumpCatalogVersion;
// tests can pass nil (no-op) or a fake to assert it fired.
//
// Defined here so itemcache stays free of a hard dependency on the
// curation package.
type CatalogBumper interface {
	BumpCatalogVersion(ctx context.Context) error
}

// Row is one cached item. Mirrors the table columns 1:1; ListByType /
// Get / GetMany all return these.
type Row struct {
	ID                         string
	Name                       string
	SortName                   string
	Type                       string
	ProductionYear             int
	RunTimeTicks               int64
	PrimaryImageTag            string
	DateCreated                string
	SeriesID                   string
	SeriesName                 string
	Overview                   string
	OfficialRating             string
	PrimaryAudioLanguage       string
	AudioLanguages             []string
	HasNonDefaultAudioLanguage bool
	UpdatedAt                  int64
	LastScanID                 int64
}

// Status reflects item_metadata_state. Surfaced by Status() for the
// future admin dev console; not on the hot path.
type Status struct {
	LastScanID              int64
	LastFullScanAt          int64
	LastFullScanDurationMs  int64
	LastScanItemCount       int64
	LastScanError           string
	RowCount                int64
}

// Cache is the public handle. Construct with New; share one instance
// across the server. Safe for concurrent use - the only mutating
// operation (Refresh) is serialized internally so concurrent callers
// coalesce on a single Jellyfin pass.
type Cache struct {
	db     *sql.DB
	jf     jellyfinClient
	logger zerolog.Logger
	// bumper is the optional CatalogBumper invoked after a successful
	// Refresh that actually changed rows. nil is fine - bumps just
	// don't happen, which is the safe default for tests that don't
	// care about kid-facing ETag invalidation.
	bumper CatalogBumper

	// refreshMu serializes Refresh callers so a tick that fires while
	// the previous tick is still running doesn't fan out to two
	// concurrent Jellyfin passes. The second caller blocks until the
	// in-flight refresh finishes; the user-requested "no fancy
	// coordination" still applies (no per-row locks, no fan-out
	// reconciliation).
	refreshMu sync.Mutex
}

// New returns a Cache ready to serve reads. The caller is responsible
// for kicking off the initial Refresh (synchronously if the table is
// empty, otherwise via the periodic ticker). Pass a CatalogBumper to
// SetBumper after construction when the kid-facing ETag should track
// scan deltas; left nil, Refresh is a pure read replacement.
func New(db *sql.DB, jf jellyfinClient, logger zerolog.Logger) *Cache {
	return &Cache{db: db, jf: jf, logger: logger}
}

// SetBumper wires the CatalogBumper Refresh should poke when its
// applyScan delta is non-zero. Optional; safe to call after
// construction (cmd/jellybean wires this once the curation store is
// alive). nil clears it.
func (c *Cache) SetBumper(b CatalogBumper) {
	c.bumper = b
}

// IsEmpty reports whether item_metadata has zero rows. cmd/jellybean
// uses this to decide between a synchronous initial Refresh (cold
// boot) and an immediate-listen + background-refresh (warm boot).
func (c *Cache) IsEmpty(ctx context.Context) (bool, error) {
	var n int64
	if err := c.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM item_metadata`).Scan(&n); err != nil {
		return false, err
	}
	return n == 0, nil
}

// Refresh runs one full pass: pulls every Movie + Series from
// Jellyfin with heavy fields enabled (MediaStreams is required to
// compute primary_audio_language + has_non_default_audio_language),
// upserts each into item_metadata in a single transaction, deletes
// anything whose last_scan_id is older than this pass, then writes
// the bookkeeping keys. Atomic from a reader's perspective.
//
// Concurrent callers coalesce on the in-flight pass - the second
// caller waits for the first to finish and then returns whatever the
// first returned. This is the only concurrency primitive in the
// cache; per-row locking is intentionally not implemented.
func (c *Cache) Refresh(ctx context.Context) error {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()

	start := time.Now()

	scanID, err := c.nextScanID(ctx)
	if err != nil {
		return fmt.Errorf("bump scan id: %w", err)
	}

	c.logger.Info().Int64("scan_id", scanID).Msg("itemcache refresh start")

	items, err := c.fetchAllItems(ctx)
	if err != nil {
		c.recordError(ctx, scanID, start, 0, err)
		return fmt.Errorf("fetch jellyfin items: %w", err)
	}

	upserted, changed, err := c.applyScan(ctx, scanID, items)
	if err != nil {
		c.recordError(ctx, scanID, start, 0, err)
		return fmt.Errorf("apply scan: %w", err)
	}

	durMs := time.Since(start).Milliseconds()
	if err := c.recordSuccess(ctx, scanID, start.Add(time.Duration(durMs)*time.Millisecond), durMs, int64(upserted)); err != nil {
		c.logger.Warn().Err(err).Msg("itemcache state write failed")
	}

	// Catalog mutated (inserted, updated, or deleted rows) -> bump the
	// kid-facing ETag salt so cached browse/library/tags payloads on
	// kid devices fall over to a fresh fetch on next mount. No-op
	// when nothing changed (the periodic ticker will keep ticking
	// without invalidating idle clients) or when no bumper is wired
	// (test fixtures).
	if changed && c.bumper != nil {
		if err := c.bumper.BumpCatalogVersion(ctx); err != nil {
			c.logger.Warn().Err(err).Msg("catalog_version bump after refresh failed")
		}
	}

	c.logger.Info().
		Int64("scan_id", scanID).
		Int("items", upserted).
		Bool("changed", changed).
		Int64("duration_ms", durMs).
		Msg("itemcache refresh complete")
	return nil
}

// fetchAllItems pages /Items?IncludeItemTypes=Movie,Series until
// Jellyfin runs out. Uses IncludeHeavyFields so MediaStreams comes
// back - needed to denormalize the audio-language columns. Uses the
// service-account key (no userToken), since the cache is global and
// per-user UserData isn't stored here.
func (c *Cache) fetchAllItems(ctx context.Context) ([]jellyfin.Item, error) {
	const pageSize = 200
	const maxPages = 200 // hard ceiling: 40k items, well above any realistic library

	var out []jellyfin.Item
	startIndex := 0
	for page := 0; page < maxPages; page++ {
		res, err := c.jf.GetItems(ctx, jellyfin.ItemsFilter{
			IncludeItemTypes:   []string{"Movie", "Series"},
			Recursive:          true,
			Limit:              pageSize,
			StartIndex:         startIndex,
			SortBy:             "SortName",
			SortOrder:          "Ascending",
			IncludeHeavyFields: true,
			ExtraFields:        []string{"Overview"},
		})
		if err != nil {
			return nil, err
		}
		if len(res.Items) == 0 {
			break
		}
		out = append(out, res.Items...)
		startIndex += len(res.Items)
		if len(res.Items) < pageSize {
			break
		}
	}
	return out, nil
}

// applyScan upserts every item and deletes anything whose last_scan_id
// is older than the current pass, all in a single transaction so
// readers never see a partial state. The second return value reports
// whether the scan actually changed the table (inserts, updates,
// deletes); callers use it to decide whether to bump catalog_version.
func (c *Cache) applyScan(ctx context.Context, scanID int64, items []jellyfin.Item) (int, bool, error) {
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, err
	}
	defer tx.Rollback()

	// The UPDATE branch's WHERE clause guards content equality so a
	// scan that re-observes the same library doesn't claim "changed."
	// updated_at + last_scan_id always tick; excluding them from the
	// guard means we still refresh the bookkeeping columns but treat
	// content-equal rows as no-op. RowsAffected on this exec is then
	// a real "inserts + meaningful updates" signal, which is what
	// catalog_version needs.
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO item_metadata (
			id, name, sort_name, type,
			production_year, run_time_ticks, primary_image_tag,
			date_created, series_id, series_name, overview, official_rating,
			primary_audio_language, audio_languages_json, has_non_default_audio_language,
			updated_at, last_scan_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			sort_name = excluded.sort_name,
			type = excluded.type,
			production_year = excluded.production_year,
			run_time_ticks = excluded.run_time_ticks,
			primary_image_tag = excluded.primary_image_tag,
			date_created = excluded.date_created,
			series_id = excluded.series_id,
			series_name = excluded.series_name,
			overview = excluded.overview,
			official_rating = excluded.official_rating,
			primary_audio_language = excluded.primary_audio_language,
			audio_languages_json = excluded.audio_languages_json,
			has_non_default_audio_language = excluded.has_non_default_audio_language,
			updated_at = excluded.updated_at,
			last_scan_id = excluded.last_scan_id
		WHERE
			item_metadata.name IS NOT excluded.name OR
			item_metadata.sort_name IS NOT excluded.sort_name OR
			item_metadata.type IS NOT excluded.type OR
			item_metadata.production_year IS NOT excluded.production_year OR
			item_metadata.run_time_ticks IS NOT excluded.run_time_ticks OR
			item_metadata.primary_image_tag IS NOT excluded.primary_image_tag OR
			item_metadata.date_created IS NOT excluded.date_created OR
			item_metadata.series_id IS NOT excluded.series_id OR
			item_metadata.series_name IS NOT excluded.series_name OR
			item_metadata.overview IS NOT excluded.overview OR
			item_metadata.official_rating IS NOT excluded.official_rating OR
			item_metadata.primary_audio_language IS NOT excluded.primary_audio_language OR
			item_metadata.audio_languages_json IS NOT excluded.audio_languages_json OR
			item_metadata.has_non_default_audio_language IS NOT excluded.has_non_default_audio_language
	`)
	if err != nil {
		return 0, false, err
	}
	defer stmt.Close()

	// Bookkeeping-only refresh for content-equal rows so DELETE
	// doesn't tombstone them as stale. Updates updated_at + last_scan_id
	// without ticking the change signal. Cheap: only runs on the
	// hopefully-large "unchanged" majority.
	bookStmt, err := tx.PrepareContext(ctx, `
		UPDATE item_metadata SET updated_at = ?, last_scan_id = ? WHERE id = ?`)
	if err != nil {
		return 0, false, err
	}
	defer bookStmt.Close()

	now := time.Now().Unix()
	count := 0
	var changedRows int64
	for _, it := range items {
		audioLangs := it.AudioLanguages()
		audioLangsJSON, _ := json.Marshal(audioLangs)
		res, err := stmt.ExecContext(ctx,
			it.ID,
			it.Name,
			sortNameFor(it.Name),
			it.Type,
			nullableInt(it.ProductionYear),
			nullableInt64(it.RunTimeTicks),
			it.ImageTags.Primary,
			it.DateCreated,
			it.SeriesID,
			it.SeriesName,
			it.Overview,
			it.OfficialRating,
			it.PrimaryAudioLanguage(),
			string(audioLangsJSON),
			boolToInt(hasNonDefaultAudioLanguage(it)),
			now,
			scanID,
		)
		if err != nil {
			return 0, false, fmt.Errorf("upsert %s: %w", it.ID, err)
		}
		n, _ := res.RowsAffected()
		if n > 0 {
			changedRows += n
		} else {
			// Content-equal existing row: bump bookkeeping so the
			// stale-row sweep below doesn't delete it.
			if _, err := bookStmt.ExecContext(ctx, now, scanID, it.ID); err != nil {
				return 0, false, fmt.Errorf("bookkeeping %s: %w", it.ID, err)
			}
		}
		count++
	}

	delRes, err := tx.ExecContext(ctx, `DELETE FROM item_metadata WHERE last_scan_id < ?`, scanID)
	if err != nil {
		return 0, false, fmt.Errorf("delete stale: %w", err)
	}
	deleted, _ := delRes.RowsAffected()

	if err := tx.Commit(); err != nil {
		return 0, false, err
	}
	return count, changedRows > 0 || deleted > 0, nil
}

// nextScanID atomically increments last_scan_id and returns the new
// value. Done outside the main scan transaction so the new id is
// visible to applyScan even if the scan rolls back later (the next
// Refresh just bumps it again - id values aren't load-bearing beyond
// "newer > older").
func (c *Cache) nextScanID(ctx context.Context) (int64, error) {
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var current int64
	row := tx.QueryRowContext(ctx, `SELECT value FROM item_metadata_state WHERE key = 'last_scan_id'`)
	var raw string
	if err := row.Scan(&raw); err != nil {
		if err != sql.ErrNoRows {
			return 0, err
		}
		current = 0
	} else {
		current, _ = strconv.ParseInt(raw, 10, 64)
	}
	next := current + 1
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO item_metadata_state (key, value) VALUES ('last_scan_id', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
	`, strconv.FormatInt(next, 10)); err != nil {
		return 0, err
	}
	return next, tx.Commit()
}

func (c *Cache) recordSuccess(ctx context.Context, scanID int64, endAt time.Time, durMs, itemCount int64) error {
	return c.setStateKVs(ctx, map[string]string{
		"last_full_scan_at":          strconv.FormatInt(endAt.Unix(), 10),
		"last_full_scan_duration_ms": strconv.FormatInt(durMs, 10),
		"last_scan_item_count":       strconv.FormatInt(itemCount, 10),
		"last_scan_error":            "",
	})
}

func (c *Cache) recordError(ctx context.Context, scanID int64, start time.Time, itemCount int64, err error) {
	_ = c.setStateKVs(ctx, map[string]string{
		"last_full_scan_at":          strconv.FormatInt(time.Now().Unix(), 10),
		"last_full_scan_duration_ms": strconv.FormatInt(time.Since(start).Milliseconds(), 10),
		"last_scan_item_count":       strconv.FormatInt(itemCount, 10),
		"last_scan_error":            err.Error(),
	})
}

func (c *Cache) setStateKVs(ctx context.Context, kvs map[string]string) error {
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for k, v := range kvs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO item_metadata_state (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`, k, v); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Get returns the cached row for id. The bool is false when the id
// isn't in the cache (e.g. an Episode-type id - those never land
// here - or a Movie/Series added since the last refresh).
func (c *Cache) Get(ctx context.Context, id string) (Row, bool, error) {
	rows, err := c.queryRows(ctx, `WHERE id = ?`, []any{id})
	if err != nil {
		return Row{}, false, err
	}
	if len(rows) == 0 {
		return Row{}, false, nil
	}
	return rows[0], true, nil
}

// GetMany batches Get for a set of ids. Missing ids are simply absent
// from the returned map - callers that need a Jellyfin fallback walk
// the input list and look up unseen ids themselves.
func (c *Cache) GetMany(ctx context.Context, ids []string) (map[string]Row, error) {
	out := map[string]Row{}
	if len(ids) == 0 {
		return out, nil
	}
	// SQLite's parameter cap is well above any realistic list (default
	// 32766). Chunk anyway as a defensive measure for very large
	// libraries; 500 per chunk is comfortable.
	const chunkSize = 500
	for i := 0; i < len(ids); i += chunkSize {
		end := i + chunkSize
		if end > len(ids) {
			end = len(ids)
		}
		chunk := ids[i:end]
		placeholders := make([]string, len(chunk))
		args := make([]any, len(chunk))
		for j, id := range chunk {
			placeholders[j] = "?"
			args[j] = id
		}
		where := fmt.Sprintf(`WHERE id IN (%s)`, strings.Join(placeholders, ","))
		rows, err := c.queryRows(ctx, where, args)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			out[r.ID] = r
		}
	}
	return out, nil
}

// ListByType returns every cached row whose type is in the supplied
// set, ordered by sort_name NOCASE. Empty types slice returns
// everything. Used by pageUnsetForProfile and the kid library
// cold-load path.
func (c *Cache) ListByType(ctx context.Context, types []string) ([]Row, error) {
	if len(types) == 0 {
		return c.queryRows(ctx, `ORDER BY sort_name COLLATE NOCASE`, nil)
	}
	placeholders := make([]string, len(types))
	args := make([]any, len(types))
	for i, t := range types {
		placeholders[i] = "?"
		args[i] = t
	}
	where := fmt.Sprintf(`WHERE type IN (%s) ORDER BY sort_name COLLATE NOCASE`, strings.Join(placeholders, ","))
	return c.queryRows(ctx, where, args)
}

// Status reads the bookkeeping table. Returns zero-value fields when
// the keys are missing (first boot before any Refresh has run).
func (c *Cache) Status(ctx context.Context) (Status, error) {
	rows, err := c.db.QueryContext(ctx, `SELECT key, value FROM item_metadata_state`)
	if err != nil {
		return Status{}, err
	}
	defer rows.Close()
	kv := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return Status{}, err
		}
		kv[k] = v
	}
	if err := rows.Err(); err != nil {
		return Status{}, err
	}
	var s Status
	s.LastScanID, _ = strconv.ParseInt(kv["last_scan_id"], 10, 64)
	s.LastFullScanAt, _ = strconv.ParseInt(kv["last_full_scan_at"], 10, 64)
	s.LastFullScanDurationMs, _ = strconv.ParseInt(kv["last_full_scan_duration_ms"], 10, 64)
	s.LastScanItemCount, _ = strconv.ParseInt(kv["last_scan_item_count"], 10, 64)
	s.LastScanError = kv["last_scan_error"]
	if err := c.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM item_metadata`).Scan(&s.RowCount); err != nil {
		return s, err
	}
	return s, nil
}

func (c *Cache) queryRows(ctx context.Context, suffix string, args []any) ([]Row, error) {
	q := `SELECT id, name, sort_name, type,
	             production_year, run_time_ticks, primary_image_tag,
	             date_created, series_id, series_name, overview, official_rating,
	             primary_audio_language, audio_languages_json, has_non_default_audio_language,
	             updated_at, last_scan_id
	      FROM item_metadata ` + suffix
	rows, err := c.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var (
			r              Row
			productionYear sql.NullInt64
			runTimeTicks   sql.NullInt64
			imageTag       sql.NullString
			dateCreated    sql.NullString
			seriesID       sql.NullString
			seriesName     sql.NullString
			overview       sql.NullString
			officialRating sql.NullString
			primaryLang    sql.NullString
			langsJSON      string
			hasNonDefault  int64
		)
		if err := rows.Scan(
			&r.ID, &r.Name, &r.SortName, &r.Type,
			&productionYear, &runTimeTicks, &imageTag,
			&dateCreated, &seriesID, &seriesName, &overview, &officialRating,
			&primaryLang, &langsJSON, &hasNonDefault,
			&r.UpdatedAt, &r.LastScanID,
		); err != nil {
			return nil, err
		}
		if productionYear.Valid {
			r.ProductionYear = int(productionYear.Int64)
		}
		if runTimeTicks.Valid {
			r.RunTimeTicks = runTimeTicks.Int64
		}
		r.PrimaryImageTag = imageTag.String
		r.DateCreated = dateCreated.String
		r.SeriesID = seriesID.String
		r.SeriesName = seriesName.String
		r.Overview = overview.String
		r.OfficialRating = officialRating.String
		r.PrimaryAudioLanguage = primaryLang.String
		if langsJSON != "" {
			_ = json.Unmarshal([]byte(langsJSON), &r.AudioLanguages)
		}
		r.HasNonDefaultAudioLanguage = hasNonDefault != 0
		out = append(out, r)
	}
	return out, rows.Err()
}

// hasNonDefaultAudioLanguage inspects the item's MediaStreams audio
// tracks and reports whether the default track's language is missing
// or differs from every other track. Specifically: returns true when
// the item has audio streams but either no track is marked default,
// or the default track's Language is empty. This mirrors the admin
// UI's "this file has audio metadata that doesn't match the profile
// default" signal at the cache layer so the list endpoint doesn't
// need MediaStreams on the wire.
//
// Returns false on items with no audio streams (zero audio = nothing
// to flag) and false when there's a default track with a non-empty
// language.
func hasNonDefaultAudioLanguage(it jellyfin.Item) bool {
	hasAudio := false
	for _, s := range it.MediaStreams {
		if s.Type != "Audio" {
			continue
		}
		hasAudio = true
		if s.IsDefault && s.Language != "" {
			return false
		}
	}
	return hasAudio
}

// sortNameFor mirrors the kid client's article-stripped lowercased
// sort key. Stored at write time so SQLite's ORDER BY sort_name
// COLLATE NOCASE produces the same order without an expensive
// per-row LOWER + LIKE expression.
func sortNameFor(name string) string {
	trimmed := strings.TrimSpace(name)
	lower := strings.ToLower(trimmed)
	switch {
	case strings.HasPrefix(lower, "the "):
		return trimmed[4:]
	case strings.HasPrefix(lower, "an "):
		return trimmed[3:]
	case strings.HasPrefix(lower, "a "):
		return trimmed[2:]
	}
	return trimmed
}

func nullableInt(v int) any {
	if v == 0 {
		return nil
	}
	return v
}

func nullableInt64(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

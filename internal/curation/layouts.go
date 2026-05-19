package curation

// Layout storage layer for M8. Layout = ordered set of rows; rows
// have a typed config (JSON blob in storage, decoded per type at the
// resolver layer in internal/server). The cache table memoizes
// resolved item ids for non-deterministic row types so randomized
// orderings stay stable inside a 60-minute window.
//
// See docs/browse-and-layouts.md (forthcoming) for the full design.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// RowType is one of the seven supported row types. Validated against
// the schema's CHECK constraint at write time.
type RowType string

const (
	RowContinueWatching RowType = "continue_watching"
	RowFavorites        RowType = "favorites"
	RowTag              RowType = "tag"
	RowTagFanout        RowType = "tag_fanout"
	RowRecentlyAdded    RowType = "recently_added"
	RowRandomUnwatched  RowType = "random_unwatched"
	RowWatchAgain       RowType = "watch_again"
)

// AllRowTypes lists every valid type. Used by the admin UI's row-type
// picker + by ParseRowType for validation.
var AllRowTypes = []RowType{
	RowContinueWatching,
	RowFavorites,
	RowTag,
	RowTagFanout,
	RowRecentlyAdded,
	RowRandomUnwatched,
	RowWatchAgain,
}

// ParseRowType validates an incoming string against AllRowTypes.
func ParseRowType(s string) (RowType, error) {
	for _, t := range AllRowTypes {
		if string(t) == s {
			return t, nil
		}
	}
	return "", fmt.Errorf("invalid row type %q", s)
}

// Layout maps to the layouts table. Description is optional;
// IsDefault is the "use this for new / null-layout profiles" flag.
type Layout struct {
	ID          int64
	Name        string
	Description string
	IsDefault   bool
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// LayoutRow maps to one layout_rows row. ConfigJSON is the raw JSON
// blob; the resolver decodes it into a per-type Go struct. Title is
// nullable (callers should treat empty string as "use the default
// title for the type").
type LayoutRow struct {
	ID         int64
	LayoutID   int64
	Position   int
	Type       RowType
	Title      string
	ConfigJSON string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// LayoutWithRows decorates Layout with its ordered rows + a
// ProfileCount used by the admin list view.
type LayoutWithRows struct {
	Layout
	Rows         []LayoutRow
	ProfileCount int
}

var (
	// ErrLayoutNotFound is returned when a layout lookup misses.
	ErrLayoutNotFound = errors.New("layout not found")
	// ErrLayoutNameTaken is returned on a UNIQUE-name collision.
	ErrLayoutNameTaken = errors.New("layout name already in use")
	// ErrLayoutProtected blocks deletion of the default layout.
	ErrLayoutProtected = errors.New("default layout cannot be deleted")
	// ErrLayoutRowNotFound is returned when a row lookup misses.
	ErrLayoutRowNotFound = errors.New("layout row not found")
)

// ListLayouts returns every layout with its row list + the number of
// profiles currently pointing at it. ProfileCount is computed via a
// correlated subquery to keep this in one round trip.
func (s *Store) ListLayouts(ctx context.Context) ([]LayoutWithRows, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT l.id, l.name, COALESCE(l.description, ''), l.is_default,
		       l.created_at, l.updated_at,
		       (SELECT COUNT(*) FROM profiles WHERE layout_id = l.id) AS profile_count
		FROM layouts l
		ORDER BY l.is_default DESC, l.name COLLATE NOCASE ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LayoutWithRows
	for rows.Next() {
		var (
			lw      LayoutWithRows
			defInt  int
			created int64
			updated int64
		)
		if err := rows.Scan(&lw.ID, &lw.Name, &lw.Description, &defInt, &created, &updated, &lw.ProfileCount); err != nil {
			return nil, err
		}
		lw.IsDefault = defInt == 1
		lw.CreatedAt = time.Unix(created, 0)
		lw.UpdatedAt = time.Unix(updated, 0)
		out = append(out, lw)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		rs, err := s.ListLayoutRows(ctx, out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Rows = rs
	}
	return out, nil
}

// GetLayout fetches one layout (without its rows). Use ListLayoutRows
// or GetLayoutWithRows when the row list is needed.
func (s *Store) GetLayout(ctx context.Context, id int64) (*Layout, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, COALESCE(description, ''), is_default, created_at, updated_at
		FROM layouts WHERE id = ?`, id)
	return scanLayout(row)
}

// GetLayoutWithRows fetches the layout + its ordered rows in one call.
func (s *Store) GetLayoutWithRows(ctx context.Context, id int64) (*LayoutWithRows, error) {
	l, err := s.GetLayout(ctx, id)
	if err != nil {
		return nil, err
	}
	rs, err := s.ListLayoutRows(ctx, id)
	if err != nil {
		return nil, err
	}
	return &LayoutWithRows{Layout: *l, Rows: rs}, nil
}

// GetDefaultLayout returns the layout flagged is_default = 1. The
// resolver uses this when a profile's layout_id is NULL (or stale).
func (s *Store) GetDefaultLayout(ctx context.Context) (*Layout, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, COALESCE(description, ''), is_default, created_at, updated_at
		FROM layouts WHERE is_default = 1
		LIMIT 1`)
	return scanLayout(row)
}

func scanLayout(row *sql.Row) (*Layout, error) {
	var (
		l       Layout
		defInt  int
		created int64
		updated int64
	)
	if err := row.Scan(&l.ID, &l.Name, &l.Description, &defInt, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrLayoutNotFound
		}
		return nil, err
	}
	l.IsDefault = defInt == 1
	l.CreatedAt = time.Unix(created, 0)
	l.UpdatedAt = time.Unix(updated, 0)
	return &l, nil
}

// LayoutInput is the create / update payload.
type LayoutInput struct {
	Name        string
	Description string
}

// CreateLayout inserts a new layout. is_default is never set from
// input; flipping the default goes through SetDefaultLayout.
func (s *Store) CreateLayout(ctx context.Context, in LayoutInput) (*Layout, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("layout name required")
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO layouts (name, description, is_default, created_at, updated_at)
		VALUES (?, ?, 0, unixepoch(), unixepoch())`,
		name, nullableString(in.Description))
	if err != nil {
		if isUniqueViolation(err, "layouts.name") {
			return nil, ErrLayoutNameTaken
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	s.bumpCatalog(ctx)
	return s.GetLayout(ctx, id)
}

// UpdateLayout applies a name + description change.
func (s *Store) UpdateLayout(ctx context.Context, id int64, in LayoutInput) (*Layout, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("layout name required")
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE layouts
		SET name = ?, description = ?, updated_at = unixepoch()
		WHERE id = ?`,
		name, nullableString(in.Description), id)
	if err != nil {
		if isUniqueViolation(err, "layouts.name") {
			return nil, ErrLayoutNameTaken
		}
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrLayoutNotFound
	}
	s.bumpCatalog(ctx)
	return s.GetLayout(ctx, id)
}

// SetDefaultLayout flips is_default to one row, clearing it on every
// other row in the same transaction.
func (s *Store) SetDefaultLayout(ctx context.Context, id int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM layouts WHERE id = ?`, id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrLayoutNotFound
	}
	if _, err := tx.ExecContext(ctx, `UPDATE layouts SET is_default = 0`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE layouts SET is_default = 1, updated_at = unixepoch() WHERE id = ?`, id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.bumpCatalog(ctx)
	return nil
}

// DeleteLayout drops a layout. Blocked when:
//   - it's flagged is_default (admin must move the default first);
//   - any profile references it (admin must reassign first).
func (s *Store) DeleteLayout(ctx context.Context, id int64) error {
	l, err := s.GetLayout(ctx, id)
	if err != nil {
		return err
	}
	if l.IsDefault {
		return ErrLayoutProtected
	}
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM profiles WHERE layout_id = ?`, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("layout has %d profile(s) assigned; reassign first", n)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM layouts WHERE id = ?`, id); err != nil {
		return err
	}
	s.bumpCatalog(ctx)
	return nil
}

// CloneLayout duplicates an existing layout (rows included). The new
// layout's name defaults to "<source> (copy)" but the caller can
// override via newName.
func (s *Store) CloneLayout(ctx context.Context, srcID int64, newName string) (*Layout, error) {
	src, err := s.GetLayout(ctx, srcID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(newName) == "" {
		newName = src.Name + " (copy)"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx, `
		INSERT INTO layouts (name, description, is_default, created_at, updated_at)
		VALUES (?, ?, 0, unixepoch(), unixepoch())`,
		newName, nullableString(src.Description))
	if err != nil {
		if isUniqueViolation(err, "layouts.name") {
			return nil, ErrLayoutNameTaken
		}
		return nil, err
	}
	dstID, _ := res.LastInsertId()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO layout_rows
		    (layout_id, position, type, title, config_json, created_at, updated_at)
		SELECT ?, position, type, title, config_json, unixepoch(), unixepoch()
		FROM layout_rows WHERE layout_id = ?`, dstID, srcID); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	s.bumpCatalog(ctx)
	return s.GetLayout(ctx, dstID)
}

// --- row mutators -------------------------------------------------------

// ListLayoutRows returns the rows for a layout in position order.
func (s *Store) ListLayoutRows(ctx context.Context, layoutID int64) ([]LayoutRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, layout_id, position, type, COALESCE(title, ''), config_json, created_at, updated_at
		FROM layout_rows
		WHERE layout_id = ?
		ORDER BY position ASC, id ASC`, layoutID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LayoutRow
	for rows.Next() {
		var (
			r       LayoutRow
			rt      string
			created int64
			updated int64
		)
		if err := rows.Scan(&r.ID, &r.LayoutID, &r.Position, &rt, &r.Title, &r.ConfigJSON, &created, &updated); err != nil {
			return nil, err
		}
		r.Type = RowType(rt)
		r.CreatedAt = time.Unix(created, 0)
		r.UpdatedAt = time.Unix(updated, 0)
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetLayoutRow fetches one row by id.
func (s *Store) GetLayoutRow(ctx context.Context, id int64) (*LayoutRow, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, layout_id, position, type, COALESCE(title, ''), config_json, created_at, updated_at
		FROM layout_rows WHERE id = ?`, id)
	var (
		r       LayoutRow
		rt      string
		created int64
		updated int64
	)
	if err := row.Scan(&r.ID, &r.LayoutID, &r.Position, &rt, &r.Title, &r.ConfigJSON, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrLayoutRowNotFound
		}
		return nil, err
	}
	r.Type = RowType(rt)
	r.CreatedAt = time.Unix(created, 0)
	r.UpdatedAt = time.Unix(updated, 0)
	return &r, nil
}

// LayoutRowInput is the create / update payload.
type LayoutRowInput struct {
	Type       RowType
	Title      string
	ConfigJSON string // raw JSON; if empty, defaults to "{}".
}

// AppendRow inserts a new row at the end of the layout's row list.
// Position is always the next index; reorder via ReorderRows after if
// the admin wants it elsewhere.
func (s *Store) AppendRow(ctx context.Context, layoutID int64, in LayoutRowInput) (*LayoutRow, error) {
	if _, err := ParseRowType(string(in.Type)); err != nil {
		return nil, err
	}
	if _, err := s.GetLayout(ctx, layoutID); err != nil {
		return nil, err
	}
	cfg := strings.TrimSpace(in.ConfigJSON)
	if cfg == "" {
		cfg = "{}"
	}
	var nextPos int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(position), -1) + 1 FROM layout_rows WHERE layout_id = ?`,
		layoutID).Scan(&nextPos); err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO layout_rows (layout_id, position, type, title, config_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
		layoutID, nextPos, string(in.Type), nullableString(in.Title), cfg)
	if err != nil {
		return nil, err
	}
	rowID, _ := res.LastInsertId()
	// Layout body changed -> kill cache for this layout so kids
	// re-resolve.
	if err := s.invalidateLayoutCache(ctx, layoutID); err != nil {
		return nil, err
	}
	s.bumpCatalog(ctx)
	return s.GetLayoutRow(ctx, rowID)
}

// UpdateRow patches title + config (and type via re-create only,
// per the issue spec). Pass an empty Type to leave it; pass empty
// ConfigJSON to leave config alone too.
func (s *Store) UpdateRow(ctx context.Context, id int64, in LayoutRowInput) (*LayoutRow, error) {
	existing, err := s.GetLayoutRow(ctx, id)
	if err != nil {
		return nil, err
	}
	rt := existing.Type
	if in.Type != "" {
		parsed, err := ParseRowType(string(in.Type))
		if err != nil {
			return nil, err
		}
		rt = parsed
	}
	cfg := existing.ConfigJSON
	if strings.TrimSpace(in.ConfigJSON) != "" {
		cfg = in.ConfigJSON
	}
	title := existing.Title
	if in.Title != "" {
		title = in.Title
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE layout_rows
		SET type = ?, title = ?, config_json = ?, updated_at = unixepoch()
		WHERE id = ?`,
		string(rt), nullableString(title), cfg, id); err != nil {
		return nil, err
	}
	if err := s.invalidateLayoutCache(ctx, existing.LayoutID); err != nil {
		return nil, err
	}
	s.bumpCatalog(ctx)
	return s.GetLayoutRow(ctx, id)
}

// DeleteRow drops a row + reflows positions so there's no gap.
func (s *Store) DeleteRow(ctx context.Context, id int64) error {
	row, err := s.GetLayoutRow(ctx, id)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM layout_rows WHERE id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE layout_rows SET position = position - 1, updated_at = unixepoch()
		WHERE layout_id = ? AND position > ?`, row.LayoutID, row.Position); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if err := s.invalidateLayoutCache(ctx, row.LayoutID); err != nil {
		return err
	}
	s.bumpCatalog(ctx)
	return nil
}

// ReorderRows sets the position of each id in `rowIDs` to its index
// in the slice. The slice must contain every row id for the layout
// (no partial reorders); missing ids leave gaps and break the resolver.
func (s *Store) ReorderRows(ctx context.Context, layoutID int64, rowIDs []int64) error {
	rs, err := s.ListLayoutRows(ctx, layoutID)
	if err != nil {
		return err
	}
	if len(rs) != len(rowIDs) {
		return fmt.Errorf("reorder must list every row id (have %d, got %d)", len(rs), len(rowIDs))
	}
	want := make(map[int64]struct{}, len(rs))
	for _, r := range rs {
		want[r.ID] = struct{}{}
	}
	for _, id := range rowIDs {
		if _, ok := want[id]; !ok {
			return fmt.Errorf("row id %d not in layout %d", id, layoutID)
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Two-phase reorder: first move every row to a unique negative
	// position so we can't trip a (theoretical) UNIQUE(layout_id,
	// position) constraint mid-update. We don't have such a constraint
	// today but the pattern keeps future-us out of trouble.
	for i, id := range rowIDs {
		if _, err := tx.ExecContext(ctx, `
			UPDATE layout_rows SET position = ?, updated_at = unixepoch()
			WHERE id = ? AND layout_id = ?`, -1-i, id, layoutID); err != nil {
			return err
		}
	}
	for i, id := range rowIDs {
		if _, err := tx.ExecContext(ctx, `
			UPDATE layout_rows SET position = ? WHERE id = ? AND layout_id = ?`,
			i, id, layoutID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if err := s.invalidateLayoutCache(ctx, layoutID); err != nil {
		return err
	}
	s.bumpCatalog(ctx)
	return nil
}

// --- profile -> layout assignment --------------------------------------

// SetProfileLayout points a profile at a layout. Pass 0 to clear
// (profile then resolves through the default layout at request time).
func (s *Store) SetProfileLayout(ctx context.Context, profileID, layoutID int64) error {
	if profileID <= 0 {
		return errors.New("profileID required")
	}
	var val any
	if layoutID > 0 {
		if _, err := s.GetLayout(ctx, layoutID); err != nil {
			return err
		}
		val = layoutID
	}
	res, err := s.db.ExecContext(ctx, `UPDATE profiles SET layout_id = ? WHERE id = ?`, val, profileID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrProfileNotFound
	}
	// Invalidate cache for this profile across all layouts; cheap and
	// keeps the next resolve from serving stale rows.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM layout_row_cache WHERE profile_id = ?`, profileID); err != nil {
		return err
	}
	s.bumpCatalog(ctx)
	return nil
}

// --- cache --------------------------------------------------------------

// CachedRowOrdering is one cache entry. Returned by GetCachedRowOrder
// when the row was generated within the TTL.
type CachedRowOrdering struct {
	GeneratedAt time.Time
	ItemIDsJSON string
}

// GetCachedRowOrder returns the cached ordering for (profile, layout,
// row) if it's still fresh (now - generated_at <= ttl). Returns nil
// when the cache miss is "no row" or "expired."
func (s *Store) GetCachedRowOrder(ctx context.Context, profileID, layoutID, rowID int64, ttl time.Duration) (*CachedRowOrdering, error) {
	var (
		generated int64
		body      string
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT generated_at, item_ids_json
		FROM layout_row_cache
		WHERE profile_id = ? AND layout_id = ? AND row_id = ?`,
		profileID, layoutID, rowID).Scan(&generated, &body)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	gen := time.Unix(generated, 0)
	if time.Since(gen) > ttl {
		return nil, nil
	}
	return &CachedRowOrdering{GeneratedAt: gen, ItemIDsJSON: body}, nil
}

// SetCachedRowOrder persists a fresh ordering. Replaces any existing
// row via UPSERT. Caller is responsible for ensuring the JSON blob
// is well-formed; we don't validate beyond storing.
func (s *Store) SetCachedRowOrder(ctx context.Context, profileID, layoutID, rowID int64, itemIDsJSON string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO layout_row_cache (profile_id, layout_id, row_id, generated_at, item_ids_json)
		VALUES (?, ?, ?, unixepoch(), ?)
		ON CONFLICT(profile_id, layout_id, row_id) DO UPDATE SET
		    generated_at = excluded.generated_at,
		    item_ids_json = excluded.item_ids_json`,
		profileID, layoutID, rowID, itemIDsJSON)
	return err
}

// InvalidateProfileLayoutCache drops every cached ordering for a
// profile (across all layouts). Used by the dev menu's force-refresh
// hook.
func (s *Store) InvalidateProfileLayoutCache(ctx context.Context, profileID int64) error {
	if profileID <= 0 {
		return errors.New("profileID required")
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM layout_row_cache WHERE profile_id = ?`, profileID)
	return err
}

// invalidateLayoutCache is called from row mutators - a layout body
// change can invalidate every profile's cache for that layout. Keeps
// the cache from serving rows that no longer exist.
func (s *Store) invalidateLayoutCache(ctx context.Context, layoutID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM layout_row_cache WHERE layout_id = ?`, layoutID)
	return err
}

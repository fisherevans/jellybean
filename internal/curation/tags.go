package curation

// Tag-related storage layer for M6. Companion to profiles.go +
// store.go (per-profile categorization). The data model is documented
// in docs/tags-and-favorites.md - read that first if any of the
// resolution rules surprise you.
//
// Tags are global (one tag namespace shared across all profiles).
// item_tags pairs (item, tag). kid_favorites is per-kid, NOT
// per-profile. profile_tag_filters lets a single profile override the
// per-profile categorization for items carrying a given tag.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Tag is a global label assignable to movies and series. Description
// is optional; sort_order lets admins drive a stable display order in
// the tag list (the kid library will surface tags in M8 in this same
// order).
type Tag struct {
	ID          int64
	Name        string
	Description string
	SortOrder   int
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// TagWithCount decorates Tag with the number of items currently
// carrying it. The admin tag list uses this for sorting + display.
type TagWithCount struct {
	Tag
	ItemCount int
}

// ProfileFilterMode is the per-profile per-tag override mode.
type ProfileFilterMode string

const (
	FilterAlwaysVisible ProfileFilterMode = "always_visible"
	FilterAlwaysHidden  ProfileFilterMode = "always_hidden"
)

// ParseProfileFilterMode validates an incoming string against the two
// allowed values. Empty strings are rejected; callers wanting to clear
// a filter use ClearProfileTagFilter.
func ParseProfileFilterMode(s string) (ProfileFilterMode, error) {
	switch ProfileFilterMode(s) {
	case FilterAlwaysVisible, FilterAlwaysHidden:
		return ProfileFilterMode(s), nil
	}
	return "", fmt.Errorf("invalid filter mode %q (expected always_visible or always_hidden)", s)
}

// ProfileTagFilter is one row of profile_tag_filters.
type ProfileTagFilter struct {
	ProfileID int64
	TagID     int64
	Mode      ProfileFilterMode
	SetAt     time.Time
}

// KidFavorite is one row of kid_favorites.
type KidFavorite struct {
	KidID          int64
	JellyfinItemID string
	CreatedAt      time.Time
}

var (
	// ErrTagNotFound is returned when a tag lookup or update misses.
	ErrTagNotFound = errors.New("tag not found")
	// ErrTagNameTaken is returned when CreateTag/UpdateTag would
	// conflict with the UNIQUE constraint on tags.name.
	ErrTagNameTaken = errors.New("tag name already in use")
)

// TagSort is the requested ordering on ListTags.
type TagSort string

const (
	TagSortName     TagSort = "name"     // alphabetical by name (default)
	TagSortCount    TagSort = "count"    // descending by item_count
	TagSortRecency  TagSort = "recency"  // descending by updated_at
	TagSortManual   TagSort = "manual"   // ascending by sort_order, then name
)

// ListTags returns tags + item counts in the requested order. Empty
// sort defaults to TagSortName.
func (s *Store) ListTags(ctx context.Context, sort TagSort) ([]TagWithCount, error) {
	orderBy := "t.name COLLATE NOCASE ASC"
	switch sort {
	case TagSortCount:
		orderBy = "item_count DESC, t.name COLLATE NOCASE ASC"
	case TagSortRecency:
		orderBy = "t.updated_at DESC, t.name COLLATE NOCASE ASC"
	case TagSortManual:
		orderBy = "t.sort_order ASC, t.name COLLATE NOCASE ASC"
	}
	q := `
		SELECT t.id, t.name, COALESCE(t.description, ''), t.sort_order,
		       t.created_at, t.updated_at,
		       (SELECT COUNT(*) FROM item_tags WHERE tag_id = t.id) AS item_count
		FROM tags t
		ORDER BY ` + orderBy
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []TagWithCount
	for rows.Next() {
		var (
			t          TagWithCount
			created    int64
			updated    int64
		)
		if err := rows.Scan(&t.ID, &t.Name, &t.Description, &t.SortOrder,
			&created, &updated, &t.ItemCount); err != nil {
			return nil, err
		}
		t.CreatedAt = time.Unix(created, 0)
		t.UpdatedAt = time.Unix(updated, 0)
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetTag fetches a single tag by id.
func (s *Store) GetTag(ctx context.Context, id int64) (*Tag, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, COALESCE(description, ''), sort_order, created_at, updated_at
		FROM tags WHERE id = ?`, id)
	var (
		t       Tag
		created int64
		updated int64
	)
	if err := row.Scan(&t.ID, &t.Name, &t.Description, &t.SortOrder, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrTagNotFound
		}
		return nil, err
	}
	t.CreatedAt = time.Unix(created, 0)
	t.UpdatedAt = time.Unix(updated, 0)
	return &t, nil
}

// TagInput is the create / update payload.
type TagInput struct {
	Name        string
	Description string
	SortOrder   int
}

// CreateTag inserts a new tag. Name is trimmed and required; UNIQUE
// constraint failures map to ErrTagNameTaken.
func (s *Store) CreateTag(ctx context.Context, in TagInput) (*Tag, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("tag name required")
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO tags (name, description, sort_order, created_at, updated_at)
		VALUES (?, ?, ?, unixepoch(), unixepoch())`,
		name, nullableString(in.Description), in.SortOrder)
	if err != nil {
		if isUniqueViolation(err, "tags.name") {
			return nil, ErrTagNameTaken
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetTag(ctx, id)
}

// UpdateTag mutates name + description + sort_order. Empty name is
// rejected.
func (s *Store) UpdateTag(ctx context.Context, id int64, in TagInput) (*Tag, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("tag name required")
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE tags
		SET name = ?, description = ?, sort_order = ?, updated_at = unixepoch()
		WHERE id = ?`,
		name, nullableString(in.Description), in.SortOrder, id)
	if err != nil {
		if isUniqueViolation(err, "tags.name") {
			return nil, ErrTagNameTaken
		}
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrTagNotFound
	}
	return s.GetTag(ctx, id)
}

// DeleteTag removes a tag. Cascade clears item_tags + profile_tag_filters
// rows that referenced it.
func (s *Store) DeleteTag(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM tags WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrTagNotFound
	}
	return nil
}

// GetTagsForItem returns the tags currently applied to one item, in
// the same order as the global tag list (alphabetical).
func (s *Store) GetTagsForItem(ctx context.Context, itemID string) ([]Tag, error) {
	if itemID == "" {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT t.id, t.name, COALESCE(t.description, ''), t.sort_order, t.created_at, t.updated_at
		FROM tags t
		JOIN item_tags it ON it.tag_id = t.id
		WHERE it.jellyfin_item_id = ?
		ORDER BY t.name COLLATE NOCASE ASC`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Tag
	for rows.Next() {
		var (
			t       Tag
			created int64
			updated int64
		)
		if err := rows.Scan(&t.ID, &t.Name, &t.Description, &t.SortOrder, &created, &updated); err != nil {
			return nil, err
		}
		t.CreatedAt = time.Unix(created, 0)
		t.UpdatedAt = time.Unix(updated, 0)
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetTagsForItems is GetTagsForItem in a batch. Returns a map of
// itemID -> []Tag for the requested items; items with no tags are
// absent from the result map. Used by the admin items listing to
// decorate every tile with its tag set in one round trip.
func (s *Store) GetTagsForItems(ctx context.Context, itemIDs []string) (map[string][]Tag, error) {
	out := make(map[string][]Tag, len(itemIDs))
	if len(itemIDs) == 0 {
		return out, nil
	}
	placeholders := strings.Repeat("?,", len(itemIDs))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, 0, len(itemIDs))
	for _, id := range itemIDs {
		args = append(args, id)
	}
	q := `
		SELECT it.jellyfin_item_id, t.id, t.name, COALESCE(t.description, ''),
		       t.sort_order, t.created_at, t.updated_at
		FROM item_tags it
		JOIN tags t ON t.id = it.tag_id
		WHERE it.jellyfin_item_id IN (` + placeholders + `)
		ORDER BY it.jellyfin_item_id, t.name COLLATE NOCASE ASC`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			itemID  string
			t       Tag
			created int64
			updated int64
		)
		if err := rows.Scan(&itemID, &t.ID, &t.Name, &t.Description, &t.SortOrder, &created, &updated); err != nil {
			return nil, err
		}
		t.CreatedAt = time.Unix(created, 0)
		t.UpdatedAt = time.Unix(updated, 0)
		out[itemID] = append(out[itemID], t)
	}
	return out, rows.Err()
}

// SetTagsForItem replaces the entire tag set for an item. Existing
// item_tags rows for the item that aren't in tagIDs get deleted; new
// ones in tagIDs that aren't already present get inserted. Idempotent.
//
// The set-based replace semantics mirror how the admin tile kebab UI
// sends tag toggles: the client sends "this item now has exactly these
// tags" rather than incremental add/remove operations. Easier for the
// UI to reason about.
func (s *Store) SetTagsForItem(ctx context.Context, itemID string, tagIDs []int64, setBy string) error {
	if itemID == "" {
		return errors.New("itemID required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Build lookup of desired tag ids.
	desired := make(map[int64]struct{}, len(tagIDs))
	for _, id := range tagIDs {
		if id <= 0 {
			continue
		}
		desired[id] = struct{}{}
	}

	// Snapshot current.
	rows, err := tx.QueryContext(ctx,
		`SELECT tag_id FROM item_tags WHERE jellyfin_item_id = ?`, itemID)
	if err != nil {
		return err
	}
	current := map[int64]struct{}{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		current[id] = struct{}{}
	}
	rows.Close()

	// Delete what's no longer wanted.
	for id := range current {
		if _, keep := desired[id]; keep {
			continue
		}
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM item_tags WHERE jellyfin_item_id = ? AND tag_id = ?`,
			itemID, id); err != nil {
			return err
		}
	}

	// Insert what's missing.
	var setByVal any
	if setBy != "" {
		setByVal = setBy
	}
	for id := range desired {
		if _, exists := current[id]; exists {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO item_tags (jellyfin_item_id, tag_id, set_at, set_by)
			VALUES (?, ?, unixepoch(), ?)`,
			itemID, id, setByVal); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// AddItemTag is a single-tag add (idempotent on conflict). Useful for
// the per-tile kebab "add tag X" path when the UI doesn't have the
// full tag set in hand.
func (s *Store) AddItemTag(ctx context.Context, itemID string, tagID int64, setBy string) error {
	if itemID == "" || tagID <= 0 {
		return errors.New("itemID and tagID required")
	}
	var setByVal any
	if setBy != "" {
		setByVal = setBy
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO item_tags (jellyfin_item_id, tag_id, set_at, set_by)
		VALUES (?, ?, unixepoch(), ?)
		ON CONFLICT(jellyfin_item_id, tag_id) DO NOTHING`,
		itemID, tagID, setByVal)
	return err
}

// RemoveItemTag drops a single (item, tag) pair if it exists.
func (s *Store) RemoveItemTag(ctx context.Context, itemID string, tagID int64) error {
	if itemID == "" || tagID <= 0 {
		return errors.New("itemID and tagID required")
	}
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM item_tags WHERE jellyfin_item_id = ? AND tag_id = ?`,
		itemID, tagID)
	return err
}

// ListItemIDsByTag returns the item ids carrying tagID, ordered by
// most-recently-tagged first. Used by the tag detail page.
func (s *Store) ListItemIDsByTag(ctx context.Context, tagID int64, limit, offset int) ([]string, error) {
	if tagID <= 0 {
		return nil, errors.New("tagID required")
	}
	if limit <= 0 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT jellyfin_item_id FROM item_tags
		WHERE tag_id = ?
		ORDER BY set_at DESC
		LIMIT ? OFFSET ?`, tagID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// --- kid favorites ------------------------------------------------------

// ListKidFavorites returns favorites for one kid, newest first.
func (s *Store) ListKidFavorites(ctx context.Context, kidID int64) ([]KidFavorite, error) {
	if kidID <= 0 {
		return nil, errors.New("kidID required")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT kid_id, jellyfin_item_id, created_at
		FROM kid_favorites
		WHERE kid_id = ?
		ORDER BY created_at DESC`, kidID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KidFavorite
	for rows.Next() {
		var (
			f       KidFavorite
			created int64
		)
		if err := rows.Scan(&f.KidID, &f.JellyfinItemID, &created); err != nil {
			return nil, err
		}
		f.CreatedAt = time.Unix(created, 0)
		out = append(out, f)
	}
	return out, rows.Err()
}

// IsKidFavorite reports whether (kid, item) is in kid_favorites.
func (s *Store) IsKidFavorite(ctx context.Context, kidID int64, itemID string) (bool, error) {
	if kidID <= 0 || itemID == "" {
		return false, nil
	}
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM kid_favorites WHERE kid_id = ? AND jellyfin_item_id = ?`,
		kidID, itemID).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// AddKidFavorite is idempotent (ON CONFLICT DO NOTHING).
func (s *Store) AddKidFavorite(ctx context.Context, kidID int64, itemID string) error {
	if kidID <= 0 || itemID == "" {
		return errors.New("kidID and itemID required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO kid_favorites (kid_id, jellyfin_item_id, created_at)
		VALUES (?, ?, unixepoch())
		ON CONFLICT(kid_id, jellyfin_item_id) DO NOTHING`,
		kidID, itemID)
	return err
}

// RemoveKidFavorite drops (kid, item) if present.
func (s *Store) RemoveKidFavorite(ctx context.Context, kidID int64, itemID string) error {
	if kidID <= 0 || itemID == "" {
		return errors.New("kidID and itemID required")
	}
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM kid_favorites WHERE kid_id = ? AND jellyfin_item_id = ?`,
		kidID, itemID)
	return err
}

// --- profile tag filters -----------------------------------------------

// ListProfileTagFilters returns all per-tag filters set on a profile.
func (s *Store) ListProfileTagFilters(ctx context.Context, profileID int64) ([]ProfileTagFilter, error) {
	if profileID <= 0 {
		return nil, errors.New("profileID required")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT profile_id, tag_id, mode, set_at
		FROM profile_tag_filters
		WHERE profile_id = ?
		ORDER BY tag_id ASC`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProfileTagFilter
	for rows.Next() {
		var (
			f     ProfileTagFilter
			mode  string
			setAt int64
		)
		if err := rows.Scan(&f.ProfileID, &f.TagID, &mode, &setAt); err != nil {
			return nil, err
		}
		f.Mode = ProfileFilterMode(mode)
		f.SetAt = time.Unix(setAt, 0)
		out = append(out, f)
	}
	return out, rows.Err()
}

// SetProfileTagFilter upserts a (profile, tag) filter row.
func (s *Store) SetProfileTagFilter(ctx context.Context, profileID, tagID int64, mode ProfileFilterMode) error {
	if profileID <= 0 || tagID <= 0 {
		return errors.New("profileID and tagID required")
	}
	if _, err := ParseProfileFilterMode(string(mode)); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO profile_tag_filters (profile_id, tag_id, mode, set_at)
		VALUES (?, ?, ?, unixepoch())
		ON CONFLICT(profile_id, tag_id) DO UPDATE SET
			mode = excluded.mode,
			set_at = excluded.set_at`,
		profileID, tagID, string(mode))
	return err
}

// ClearProfileTagFilter removes the filter for (profile, tag) - the
// item now resolves through normal categorization for the profile.
func (s *Store) ClearProfileTagFilter(ctx context.Context, profileID, tagID int64) error {
	if profileID <= 0 || tagID <= 0 {
		return errors.New("profileID and tagID required")
	}
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM profile_tag_filters WHERE profile_id = ? AND tag_id = ?`,
		profileID, tagID)
	return err
}

// EffectiveItemVisibility resolves an item's visibility for a profile
// using the precedence rules from docs/tags-and-favorites.md:
//
//  1. If any tag on the item has always_hidden for this profile -> hidden.
//  2. Else if any tag has always_visible for this profile -> visible.
//  3. Else: fall back to the per-profile categorization. unset -> hidden.
//
// always_hidden wins over always_visible when both apply (safer
// default - the kid app errs toward hiding).
//
// This MUST be the only path the kid library code uses to decide
// whether to surface an item. Reading categorizations.state directly
// for the kid path will silently bypass tag filters.
func (s *Store) EffectiveItemVisibility(ctx context.Context, profileID int64, itemID string) (State, error) {
	if profileID <= 0 || itemID == "" {
		return StateHidden, nil
	}
	// Single roundtrip: pull every filter mode that applies to any of
	// this item's tags for this profile.
	rows, err := s.db.QueryContext(ctx, `
		SELECT ptf.mode
		FROM item_tags it
		JOIN profile_tag_filters ptf
		    ON ptf.tag_id = it.tag_id AND ptf.profile_id = ?
		WHERE it.jellyfin_item_id = ?`, profileID, itemID)
	if err != nil {
		return StateHidden, err
	}
	defer rows.Close()
	sawVisible := false
	for rows.Next() {
		var mode string
		if err := rows.Scan(&mode); err != nil {
			return StateHidden, err
		}
		switch ProfileFilterMode(mode) {
		case FilterAlwaysHidden:
			return StateHidden, nil
		case FilterAlwaysVisible:
			sawVisible = true
		}
	}
	if err := rows.Err(); err != nil {
		return StateHidden, err
	}
	if sawVisible {
		return StateVisible, nil
	}
	// Fall back to categorization. orphan rows are skipped (treated as
	// no row -> hidden) per the existing categorization logic.
	st, err := s.GetState(ctx, itemID, profileID)
	if err != nil {
		return StateHidden, err
	}
	if st == nil {
		return StateHidden, nil
	}
	return *st, nil
}

// EffectiveItemVisibilityBulk is EffectiveItemVisibility in a batch.
// Returns a map itemID -> State for every requested item. Items not
// present resolve to StateHidden. The kid library listing uses this
// path to filter in one trip rather than per-item.
func (s *Store) EffectiveItemVisibilityBulk(ctx context.Context, profileID int64, itemIDs []string) (map[string]State, error) {
	out := make(map[string]State, len(itemIDs))
	if profileID <= 0 || len(itemIDs) == 0 {
		return out, nil
	}
	// Build placeholders.
	ph := strings.Repeat("?,", len(itemIDs))
	ph = ph[:len(ph)-1]
	args := make([]any, 0, len(itemIDs)+1)
	args = append(args, profileID)
	for _, id := range itemIDs {
		args = append(args, id)
		out[id] = StateHidden
	}

	// Pass 1: find filter overrides.
	q := `
		SELECT it.jellyfin_item_id, ptf.mode
		FROM item_tags it
		JOIN profile_tag_filters ptf
		    ON ptf.tag_id = it.tag_id AND ptf.profile_id = ?
		WHERE it.jellyfin_item_id IN (` + ph + `)`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	type filterAgg struct {
		hidden  bool
		visible bool
	}
	overrides := map[string]*filterAgg{}
	for rows.Next() {
		var id, mode string
		if err := rows.Scan(&id, &mode); err != nil {
			rows.Close()
			return nil, err
		}
		agg, ok := overrides[id]
		if !ok {
			agg = &filterAgg{}
			overrides[id] = agg
		}
		switch ProfileFilterMode(mode) {
		case FilterAlwaysHidden:
			agg.hidden = true
		case FilterAlwaysVisible:
			agg.visible = true
		}
	}
	rows.Close()

	// Pass 2: per-profile categorization for the items not yet
	// resolved by filters.
	stateMap, err := s.GetStatesForItems(ctx, profileID, itemIDs)
	if err != nil {
		return nil, err
	}

	// Apply precedence per item.
	for _, id := range itemIDs {
		if agg, ok := overrides[id]; ok {
			if agg.hidden {
				out[id] = StateHidden
				continue
			}
			if agg.visible {
				out[id] = StateVisible
				continue
			}
		}
		if st, ok := stateMap[id]; ok {
			out[id] = st
			continue
		}
		out[id] = StateHidden
	}
	return out, nil
}

// IsItemVisibleForAnyProfile reports whether at least one profile has
// the item categorized as visible (not hidden, not unset, not
// orphan-tombstoned). Used by the M6 tag-assignment guard so admins
// don't accidentally tag content no one can see.
func (s *Store) IsItemVisibleForAnyProfile(ctx context.Context, itemID string) (bool, error) {
	if itemID == "" {
		return false, nil
	}
	var n int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM categorizations
		WHERE jellyfin_item_id = ?
		  AND state = 'visible'
		  AND orphan_at IS NULL`, itemID).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// isUniqueViolation checks whether err is a SQLite UNIQUE constraint
// violation on the named column. modernc.org/sqlite returns the
// constraint message in the error text; this matches on substring.
// Brittle but cheap; the alternative is unwrapping the driver-specific
// error type.
func isUniqueViolation(err error, columnPath string) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") &&
		strings.Contains(msg, columnPath)
}

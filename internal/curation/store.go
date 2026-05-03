// Package curation owns Jellybean's per-profile visibility state.
//
// Each (item, profile) pair is independently visible, hidden, or unset.
// A future "Zoe" profile gets her own triage; Ollie's decisions don't
// carry over. The kid-stream filter for a given profile shows only items
// whose state is 'visible' for that profile.
package curation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// State is the per-profile visibility verdict for an item.
type State string

const (
	StateVisible State = "visible"
	StateHidden  State = "hidden"
)

// Source tracks how a categorization landed in the table; used by the
// future "auto-apply high-confidence suggestions" flow to distinguish
// manual from machine-applied entries.
type Source string

const (
	SourceManual    Source = "manual"
	SourceSuggested Source = "auto-suggested"
)

// ParseState validates a state string from a request body.
func ParseState(s string) (State, error) {
	switch State(s) {
	case StateVisible, StateHidden:
		return State(s), nil
	}
	return "", fmt.Errorf("invalid state %q (expected visible or hidden)", s)
}

// Store is the data access layer for categorizations + history.
type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// HistoryEntry mirrors one row from categorization_history.
type HistoryEntry struct {
	ID         int64
	ItemID     string
	ProfileID  int64
	FromState  *State // nil = no prior state
	ToState    *State // nil = removed (back to unset)
	ChangedBy  string
	ChangedAt  time.Time
}

// SetState upserts the visibility for a single (item, profile) pair and
// appends to history. Pass nil for `state` to clear (mark unset). Returns
// the previous state (or nil if none) so callers can implement undo /
// "from -> to" displays.
func (s *Store) SetState(ctx context.Context, itemID string, profileID int64, state *State, setBy string) (*State, error) {
	if itemID == "" {
		return nil, errors.New("itemID required")
	}
	if profileID <= 0 {
		return nil, errors.New("profileID required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	prev, err := getStateTx(ctx, tx, itemID, profileID)
	if err != nil {
		return nil, err
	}
	if statePtrEqual(prev, state) {
		return prev, tx.Commit()
	}
	if state == nil {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM categorizations WHERE jellyfin_item_id = ? AND profile_id = ?`,
			itemID, profileID); err != nil {
			return nil, err
		}
	} else {
		if err := upsertStateTx(ctx, tx, itemID, profileID, *state, SourceManual, setBy); err != nil {
			return nil, err
		}
	}
	if err := appendHistoryTx(ctx, tx, itemID, profileID, prev, state, setBy); err != nil {
		return nil, err
	}
	return prev, tx.Commit()
}

// SetStateBulk applies the same state to many items for a single profile
// in one transaction. Returns the count of items whose state actually
// changed.
func (s *Store) SetStateBulk(ctx context.Context, itemIDs []string, profileID int64, state *State, setBy string) (int, error) {
	if len(itemIDs) == 0 {
		return 0, nil
	}
	if profileID <= 0 {
		return 0, errors.New("profileID required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	changed := 0
	for _, id := range itemIDs {
		if id == "" {
			continue
		}
		prev, err := getStateTx(ctx, tx, id, profileID)
		if err != nil {
			return 0, err
		}
		if statePtrEqual(prev, state) {
			continue
		}
		if state == nil {
			if _, err := tx.ExecContext(ctx,
				`DELETE FROM categorizations WHERE jellyfin_item_id = ? AND profile_id = ?`,
				id, profileID); err != nil {
				return 0, err
			}
		} else {
			if err := upsertStateTx(ctx, tx, id, profileID, *state, SourceManual, setBy); err != nil {
				return 0, err
			}
		}
		if err := appendHistoryTx(ctx, tx, id, profileID, prev, state, setBy); err != nil {
			return 0, err
		}
		changed++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return changed, nil
}

// GetState returns the current visibility for one (item, profile), or nil
// if the row is unset.
func (s *Store) GetState(ctx context.Context, itemID string, profileID int64) (*State, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT state FROM categorizations WHERE jellyfin_item_id = ? AND profile_id = ?`,
		itemID, profileID)
	var v string
	if err := row.Scan(&v); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	st := State(v)
	return &st, nil
}

// GetStatesForItems returns a map of itemID -> state for the given items
// and profile. Items without a row are absent from the result.
func (s *Store) GetStatesForItems(ctx context.Context, profileID int64, itemIDs []string) (map[string]State, error) {
	out := make(map[string]State, len(itemIDs))
	if len(itemIDs) == 0 || profileID <= 0 {
		return out, nil
	}
	placeholders := strings.Repeat("?,", len(itemIDs))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, 0, len(itemIDs)+1)
	args = append(args, profileID)
	for _, id := range itemIDs {
		args = append(args, id)
	}
	q := `SELECT jellyfin_item_id, state FROM categorizations
		WHERE profile_id = ? AND jellyfin_item_id IN (` + placeholders + `)`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, st string
		if err := rows.Scan(&id, &st); err != nil {
			return nil, err
		}
		out[id] = State(st)
	}
	return out, rows.Err()
}

// ListItemIDsInState returns IDs whose stored state for the given profile
// matches `state`, ordered by most-recently-set first.
func (s *Store) ListItemIDsInState(ctx context.Context, profileID int64, state State, limit, offset int) ([]string, error) {
	if limit <= 0 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT jellyfin_item_id FROM categorizations
		WHERE profile_id = ? AND state = ?
		ORDER BY set_at DESC
		LIMIT ? OFFSET ?`, profileID, string(state), limit, offset)
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

// AllCategorizedIDsForProfile returns every item ID that has ANY state
// (visible or hidden) for the given profile. The "uncategorized" sweep
// view uses this set to skip items the parent has already decided on.
func (s *Store) AllCategorizedIDsForProfile(ctx context.Context, profileID int64) (map[string]struct{}, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT jellyfin_item_id FROM categorizations WHERE profile_id = ?`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]struct{})
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

// RecentHistory returns the last N history entries for the given profile,
// newest first. Pass profileID = 0 to get history across all profiles.
func (s *Store) RecentHistory(ctx context.Context, profileID int64, limit int) ([]HistoryEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var (
		rows *sql.Rows
		err  error
	)
	if profileID == 0 {
		rows, err = s.db.QueryContext(ctx, `
			SELECT id, jellyfin_item_id, profile_id, from_state, to_state, changed_by, changed_at
			FROM categorization_history
			ORDER BY changed_at DESC, id DESC
			LIMIT ?`, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `
			SELECT id, jellyfin_item_id, profile_id, from_state, to_state, changed_by, changed_at
			FROM categorization_history
			WHERE profile_id = ?
			ORDER BY changed_at DESC, id DESC
			LIMIT ?`, profileID, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []HistoryEntry
	for rows.Next() {
		var (
			e          HistoryEntry
			fromN, toN sql.NullString
			byN        sql.NullString
			at         int64
		)
		if err := rows.Scan(&e.ID, &e.ItemID, &e.ProfileID, &fromN, &toN, &byN, &at); err != nil {
			return nil, err
		}
		if fromN.Valid {
			s := State(fromN.String)
			e.FromState = &s
		}
		if toN.Valid {
			s := State(toN.String)
			e.ToState = &s
		}
		if byN.Valid {
			e.ChangedBy = byN.String
		}
		e.ChangedAt = time.Unix(at, 0)
		out = append(out, e)
	}
	return out, rows.Err()
}

// --- internal helpers (operate within a transaction) --------------------

func getStateTx(ctx context.Context, tx *sql.Tx, itemID string, profileID int64) (*State, error) {
	row := tx.QueryRowContext(ctx,
		`SELECT state FROM categorizations WHERE jellyfin_item_id = ? AND profile_id = ?`,
		itemID, profileID)
	var v string
	if err := row.Scan(&v); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	st := State(v)
	return &st, nil
}

// CopyCategorizations bulk-copies every categorization row from src to
// dst. Existing rows in dst with the same item id are left alone (no-op
// on conflict). Returns the number of rows inserted. Used when creating
// a new profile that should start from another profile's decisions.
func (s *Store) CopyCategorizations(ctx context.Context, src, dst int64) (int, error) {
	if src <= 0 || dst <= 0 || src == dst {
		return 0, fmt.Errorf("invalid src/dst profile ids")
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT OR IGNORE INTO categorizations (
			jellyfin_item_id, profile_id, state, source, set_at, set_by
		)
		SELECT jellyfin_item_id, ?, state, source, unixepoch(), 'profile-copy'
		FROM categorizations
		WHERE profile_id = ?`, dst, src)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

func upsertStateTx(ctx context.Context, tx *sql.Tx, itemID string, profileID int64, state State, src Source, setBy string) error {
	var setByVal any
	if setBy != "" {
		setByVal = setBy
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO categorizations (jellyfin_item_id, profile_id, state, source, set_at, set_by)
		VALUES (?, ?, ?, ?, unixepoch(), ?)
		ON CONFLICT(jellyfin_item_id, profile_id) DO UPDATE SET
			state = excluded.state,
			source = excluded.source,
			set_at = excluded.set_at,
			set_by = excluded.set_by`,
		itemID, profileID, string(state), string(src), setByVal)
	return err
}

func appendHistoryTx(ctx context.Context, tx *sql.Tx, itemID string, profileID int64, from, to *State, by string) error {
	var fromVal, toVal, byVal any
	if from != nil {
		fromVal = string(*from)
	}
	if to != nil {
		toVal = string(*to)
	}
	if by != "" {
		byVal = by
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO categorization_history (jellyfin_item_id, profile_id, from_state, to_state, changed_by, changed_at)
		VALUES (?, ?, ?, ?, ?, unixepoch())`,
		itemID, profileID, fromVal, toVal, byVal)
	return err
}

func statePtrEqual(a, b *State) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

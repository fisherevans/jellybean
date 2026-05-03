// Package curation owns Jellybean's categorization state and the data access
// for the parent web app's curation features. The store is the source of
// truth for "is this item kid-safe."
//
// Categorization is binary kid/adult/uncategorized at the item level. Profile
// rules will gate visibility per kid in a later milestone but do not change
// what is stored here.
package curation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Category is one of three possible labels on a Jellyfin item.
type Category string

const (
	CategoryKid           Category = "kid"
	CategoryAdult         Category = "adult"
	CategoryUncategorized Category = "uncategorized"
)

// Source tracks how a categorization landed in the table; used by the future
// "auto-apply high-confidence suggestions" flow to distinguish manual decisions
// from machine-applied ones.
type Source string

const (
	SourceManual    Source = "manual"
	SourceSuggested Source = "auto-suggested"
)

// ParseCategory validates and returns a Category from a user-supplied string.
func ParseCategory(s string) (Category, error) {
	switch Category(s) {
	case CategoryKid, CategoryAdult, CategoryUncategorized:
		return Category(s), nil
	}
	return "", fmt.Errorf("invalid category %q (expected kid, adult, or uncategorized)", s)
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
	ID           int64
	ItemID       string
	FromCategory Category // empty when this is the first categorization for the item
	ToCategory   Category
	ChangedBy    string
	ChangedAt    time.Time
}

// SetCategory upserts a single item's category and appends to history.
// Returns the previous category (or empty if none) for callers that need it.
func (s *Store) SetCategory(ctx context.Context, itemID string, cat Category, setBy string) (Category, error) {
	if itemID == "" {
		return "", errors.New("itemID required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	prev, err := getCategoryTx(ctx, tx, itemID)
	if err != nil {
		return "", err
	}
	if prev == cat {
		// No-op: don't pollute history with redundant rows.
		return prev, tx.Commit()
	}
	if err := upsertCategoryTx(ctx, tx, itemID, cat, SourceManual, setBy); err != nil {
		return "", err
	}
	if err := appendHistoryTx(ctx, tx, itemID, prev, cat, setBy); err != nil {
		return "", err
	}
	return prev, tx.Commit()
}

// SetCategoryBulk applies the same category to many items in one transaction.
// Returns the count of items whose category actually changed (so a no-op
// re-tag of already-correct items doesn't inflate the number).
func (s *Store) SetCategoryBulk(ctx context.Context, itemIDs []string, cat Category, setBy string) (int, error) {
	if len(itemIDs) == 0 {
		return 0, nil
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
		prev, err := getCategoryTx(ctx, tx, id)
		if err != nil {
			return 0, err
		}
		if prev == cat {
			continue
		}
		if err := upsertCategoryTx(ctx, tx, id, cat, SourceManual, setBy); err != nil {
			return 0, err
		}
		if err := appendHistoryTx(ctx, tx, id, prev, cat, setBy); err != nil {
			return 0, err
		}
		changed++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return changed, nil
}

// GetCategory returns the current category, or CategoryUncategorized when
// the item has no row yet.
func (s *Store) GetCategory(ctx context.Context, itemID string) (Category, error) {
	row := s.db.QueryRowContext(ctx, `SELECT category FROM categorizations WHERE jellyfin_item_id = ?`, itemID)
	var c string
	if err := row.Scan(&c); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return CategoryUncategorized, nil
		}
		return "", err
	}
	return Category(c), nil
}

// GetCategoriesForItems returns a map of itemID -> category for the given IDs.
// Items not found in the table are absent from the result; callers should
// treat absence as CategoryUncategorized.
func (s *Store) GetCategoriesForItems(ctx context.Context, itemIDs []string) (map[string]Category, error) {
	out := make(map[string]Category, len(itemIDs))
	if len(itemIDs) == 0 {
		return out, nil
	}
	// Build "?, ?, ?, ..." placeholder list. SQLite has a default limit of
	// 999 placeholders per query (raised to 32766 in newer builds), more
	// than enough for our scale.
	placeholders := strings.Repeat("?,", len(itemIDs))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, len(itemIDs))
	for i, id := range itemIDs {
		args[i] = id
	}
	q := `SELECT jellyfin_item_id, category FROM categorizations WHERE jellyfin_item_id IN (` + placeholders + `)`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, cat string
		if err := rows.Scan(&id, &cat); err != nil {
			return nil, err
		}
		out[id] = Category(cat)
	}
	return out, rows.Err()
}

// RecentHistory returns the last N history entries, newest first.
func (s *Store) RecentHistory(ctx context.Context, limit int) ([]HistoryEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, jellyfin_item_id, from_category, to_category, changed_by, changed_at
		FROM categorization_history
		ORDER BY changed_at DESC, id DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []HistoryEntry
	for rows.Next() {
		var (
			e    HistoryEntry
			from sql.NullString
			by   sql.NullString
			at   int64
		)
		if err := rows.Scan(&e.ID, &e.ItemID, &from, &e.ToCategory, &by, &at); err != nil {
			return nil, err
		}
		if from.Valid {
			e.FromCategory = Category(from.String)
		}
		if by.Valid {
			e.ChangedBy = by.String
		}
		e.ChangedAt = time.Unix(at, 0)
		out = append(out, e)
	}
	return out, rows.Err()
}

// --- internal helpers (operate within a transaction) --------------------

func getCategoryTx(ctx context.Context, tx *sql.Tx, itemID string) (Category, error) {
	row := tx.QueryRowContext(ctx, `SELECT category FROM categorizations WHERE jellyfin_item_id = ?`, itemID)
	var c string
	if err := row.Scan(&c); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return Category(c), nil
}

func upsertCategoryTx(ctx context.Context, tx *sql.Tx, itemID string, cat Category, src Source, setBy string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO categorizations (jellyfin_item_id, category, source, set_at, set_by)
		VALUES (?, ?, ?, unixepoch(), ?)
		ON CONFLICT(jellyfin_item_id) DO UPDATE SET
			category = excluded.category,
			source = excluded.source,
			set_at = excluded.set_at,
			set_by = excluded.set_by`,
		itemID, string(cat), string(src), setBy)
	return err
}

func appendHistoryTx(ctx context.Context, tx *sql.Tx, itemID string, from, to Category, by string) error {
	var fromVal any
	if from != "" {
		fromVal = string(from)
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO categorization_history (jellyfin_item_id, from_category, to_category, changed_by, changed_at)
		VALUES (?, ?, ?, ?, unixepoch())`,
		itemID, fromVal, string(to), by)
	return err
}

// Package curation owns Jellybean's categorization state and the data access
// for the parent web app's curation features. The store is the source of
// truth for "what minimum age this item is appropriate for."
//
// Categorizations are recorded as a numeric minimum age (in years). NULL
// means the item is uncategorized. Common tiers: 2 (toddler), 5 (preschool),
// 7 (younger kid), 13 (teen), 18 (adult / not for kids). Profile rules will
// gate visibility per kid by comparing against this number; for now the
// only consumer is the curation UI.
package curation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// AgeTier values are the standard buckets the UI shows. They are not a
// closed set: the schema accepts any non-negative integer so we can add
// granularity later (e.g. 16 for older teens) without a schema change.
const (
	AgeToddler   = 2
	AgePreschool = 5
	AgeKid       = 7
	AgeTeen      = 13
	AgeAdult     = 18
)

// MinAge is a nullable age. The zero value (0) is "any age" / "no minimum",
// which we don't currently use. Use a *int when the absence of a value
// matters; this type is for documentation.
type MinAge = int

// Source tracks how a categorization landed in the table; used by the
// future "auto-apply high-confidence suggestions" flow to distinguish manual
// decisions from machine-applied ones.
type Source string

const (
	SourceManual    Source = "manual"
	SourceSuggested Source = "auto-suggested"
)

// Store is the data access layer for categorizations + history.
type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// HistoryEntry mirrors one row from categorization_history. Nullable ages
// are surfaced as nil pointers so JSON encoding can render them as null.
type HistoryEntry struct {
	ID         int64
	ItemID     string
	FromAge    *int
	ToAge      *int
	ChangedBy  string
	ChangedAt  time.Time
}

// SetAge upserts a single item's minimum age and appends to history.
// Pass nil for `age` to mark the item uncategorized. Returns the previous
// age (or nil if none) so callers can implement undo / display "from -> to".
func (s *Store) SetAge(ctx context.Context, itemID string, age *int, setBy string) (*int, error) {
	if itemID == "" {
		return nil, errors.New("itemID required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	prev, err := getAgeTx(ctx, tx, itemID)
	if err != nil {
		return nil, err
	}
	if intPtrEqual(prev, age) {
		return prev, tx.Commit()
	}
	if err := upsertAgeTx(ctx, tx, itemID, age, SourceManual, setBy); err != nil {
		return nil, err
	}
	if err := appendHistoryTx(ctx, tx, itemID, prev, age, setBy); err != nil {
		return nil, err
	}
	return prev, tx.Commit()
}

// SetAgeBulk applies the same minimum age to many items in one transaction.
// Returns the count of items whose age actually changed.
func (s *Store) SetAgeBulk(ctx context.Context, itemIDs []string, age *int, setBy string) (int, error) {
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
		prev, err := getAgeTx(ctx, tx, id)
		if err != nil {
			return 0, err
		}
		if intPtrEqual(prev, age) {
			continue
		}
		if err := upsertAgeTx(ctx, tx, id, age, SourceManual, setBy); err != nil {
			return 0, err
		}
		if err := appendHistoryTx(ctx, tx, id, prev, age, setBy); err != nil {
			return 0, err
		}
		changed++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return changed, nil
}

// GetAge returns the current minimum age for an item, or nil if the item
// has not been categorized.
func (s *Store) GetAge(ctx context.Context, itemID string) (*int, error) {
	row := s.db.QueryRowContext(ctx, `SELECT min_age FROM categorizations WHERE jellyfin_item_id = ?`, itemID)
	var n sql.NullInt64
	if err := row.Scan(&n); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if !n.Valid {
		return nil, nil
	}
	v := int(n.Int64)
	return &v, nil
}

// GetAgesForItems returns a map of itemID -> *minAge for the given IDs.
// Items not in the table or with NULL min_age are absent from the result.
func (s *Store) GetAgesForItems(ctx context.Context, itemIDs []string) (map[string]int, error) {
	out := make(map[string]int, len(itemIDs))
	if len(itemIDs) == 0 {
		return out, nil
	}
	placeholders := strings.Repeat("?,", len(itemIDs))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, len(itemIDs))
	for i, id := range itemIDs {
		args[i] = id
	}
	q := `SELECT jellyfin_item_id, min_age FROM categorizations WHERE jellyfin_item_id IN (` + placeholders + `) AND min_age IS NOT NULL`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n sql.NullInt64
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		if n.Valid {
			out[id] = int(n.Int64)
		}
	}
	return out, rows.Err()
}

// AgeBucket is a coarser-grained label the kid-stream filtering layer cares
// about. Lets the existing API surface (?category=kid|adult|uncategorized)
// keep working without exposing tier semantics outside this package.
type AgeBucket string

const (
	BucketKid           AgeBucket = "kid"
	BucketAdult         AgeBucket = "adult"
	BucketUncategorized AgeBucket = "uncategorized"
)

// AgeToBucket maps a stored min_age (or nil) to the coarse bucket. The
// kid/adult cutoff sits at 13: ages 12 and below are "kid", 13 and above
// are "adult". This is purely a UI convenience; the underlying age value
// is what gets stored.
func AgeToBucket(age *int) AgeBucket {
	if age == nil {
		return BucketUncategorized
	}
	if *age < 13 {
		return BucketKid
	}
	return BucketAdult
}

// ParseBucket validates a bucket string from a query param.
func ParseBucket(s string) (AgeBucket, error) {
	switch AgeBucket(s) {
	case BucketKid, BucketAdult, BucketUncategorized:
		return AgeBucket(s), nil
	}
	return "", fmt.Errorf("invalid bucket %q (expected kid, adult, or uncategorized)", s)
}

// ListItemIDsInBucket returns IDs whose stored min_age maps to the given
// bucket, ordered by most-recently-set first. Used by the items handler to
// page through filtered views without fetching the entire library.
func (s *Store) ListItemIDsInBucket(ctx context.Context, bucket AgeBucket, limit, offset int) ([]string, error) {
	if limit <= 0 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	var where string
	switch bucket {
	case BucketKid:
		where = "min_age IS NOT NULL AND min_age < 13"
	case BucketAdult:
		where = "min_age IS NOT NULL AND min_age >= 13"
	default:
		return nil, fmt.Errorf("ListItemIDsInBucket only supports kid / adult; got %q", bucket)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT jellyfin_item_id FROM categorizations
		WHERE `+where+`
		ORDER BY set_at DESC
		LIMIT ? OFFSET ?`, limit, offset)
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

// AllCategorizedIDs returns every item ID that has a non-NULL min_age. The
// items handler uses this to filter the "uncategorized" view by paging
// through Jellyfin's catalog and skipping anything in the returned set.
func (s *Store) AllCategorizedIDs(ctx context.Context) (map[string]struct{}, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT jellyfin_item_id FROM categorizations
		WHERE min_age IS NOT NULL`)
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

// RecentHistory returns the last N history entries, newest first.
func (s *Store) RecentHistory(ctx context.Context, limit int) ([]HistoryEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, jellyfin_item_id, from_min_age, to_min_age, changed_by, changed_at
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
			from sql.NullInt64
			to   sql.NullInt64
			by   sql.NullString
			at   int64
		)
		if err := rows.Scan(&e.ID, &e.ItemID, &from, &to, &by, &at); err != nil {
			return nil, err
		}
		if from.Valid {
			v := int(from.Int64)
			e.FromAge = &v
		}
		if to.Valid {
			v := int(to.Int64)
			e.ToAge = &v
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

func getAgeTx(ctx context.Context, tx *sql.Tx, itemID string) (*int, error) {
	row := tx.QueryRowContext(ctx, `SELECT min_age FROM categorizations WHERE jellyfin_item_id = ?`, itemID)
	var n sql.NullInt64
	if err := row.Scan(&n); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if !n.Valid {
		return nil, nil
	}
	v := int(n.Int64)
	return &v, nil
}

func upsertAgeTx(ctx context.Context, tx *sql.Tx, itemID string, age *int, src Source, setBy string) error {
	var ageVal any
	if age != nil {
		ageVal = *age
	}
	var setByVal any
	if setBy != "" {
		setByVal = setBy
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO categorizations (jellyfin_item_id, min_age, source, set_at, set_by)
		VALUES (?, ?, ?, unixepoch(), ?)
		ON CONFLICT(jellyfin_item_id) DO UPDATE SET
			min_age = excluded.min_age,
			source = excluded.source,
			set_at = excluded.set_at,
			set_by = excluded.set_by`,
		itemID, ageVal, string(src), setByVal)
	return err
}

func appendHistoryTx(ctx context.Context, tx *sql.Tx, itemID string, from, to *int, by string) error {
	var fromVal, toVal, byVal any
	if from != nil {
		fromVal = *from
	}
	if to != nil {
		toVal = *to
	}
	if by != "" {
		byVal = by
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO categorization_history (jellyfin_item_id, from_min_age, to_min_age, changed_by, changed_at)
		VALUES (?, ?, ?, ?, unixepoch())`,
		itemID, fromVal, toVal, byVal)
	return err
}

func intPtrEqual(a, b *int) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}


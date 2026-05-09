package curation

// Shared helpers for the per-profile config tables (profile_time_limits,
// profile_body_breaks, profile_viewing_controls). Each of those tables
// has the same access shape: SELECT by profile_id, fall back to a
// canonical default when the row is missing. The upserts differ
// per-table (different column sets) and stay open-coded - generifying
// them would push toward reflection / struct-tag SQL, which the
// project deliberately avoids.

import (
	"context"
	"database/sql"
	"errors"
)

// loadOrDefault runs a single-row query keyed on profileID and decodes
// it via scan. On sql.ErrNoRows it returns defaults and a nil error;
// any other error returns the zero value alongside the error.
//
// The scan callback receives the *sql.Row and is responsible for
// populating whatever destination it closes over and assembling the
// final value. The callback is only invoked when a row exists.
func loadOrDefault[T any](ctx context.Context, db *sql.DB, query string, profileID int64, scan func(*sql.Row) (T, error), defaults T) (T, error) {
	var zero T
	row := db.QueryRowContext(ctx, query, profileID)
	v, err := scan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return defaults, nil
	}
	if err != nil {
		return zero, err
	}
	return v, nil
}

package curation

import (
	"database/sql"
	"time"
)

// Helpers for the read-side ceremony around nullable SQL columns and unix
// timestamps. The curation tables store time as int64 unix seconds and
// allow NULL on a handful of columns; the row-scan code throughout this
// package would otherwise re-derive the same conversions inline.
//
// Only the "default to zero/empty when null" cases use these helpers.
// Sites that branch on validity (e.g. wrapping into a *T pointer or
// taking a different code path) are left as explicit `if v.Valid {}`
// blocks because the helper would erase the meaningful distinction.

// scanNullableString returns the underlying string, or "" when the
// column was NULL.
func scanNullableString(ns sql.NullString) string {
	if !ns.Valid {
		return ""
	}
	return ns.String
}

// scanNullableInt64 returns the underlying int64, or 0 when the column
// was NULL.
func scanNullableInt64(ni sql.NullInt64) int64 {
	if !ni.Valid {
		return 0
	}
	return ni.Int64
}

// unixToTime converts a unix-seconds column into a UTC time.Time. The
// curation schema stores all timestamps as int64 unix seconds; render
// them in UTC to keep formatting deterministic across machines.
func unixToTime(n int64) time.Time {
	return time.Unix(n, 0).UTC()
}

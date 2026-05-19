package curation

// Adult override mode (M9). The kid TV holds a long-press UP gesture
// to unlock a per-item edit modal; before that modal opens the kid
// client posts a PIN to verify-pin which mints a short-lived session
// token that gates subsequent action endpoints.
//
// Lockout: after MaxFailedAttempts wrong PIN entries we set
// locked_until = now + LockoutDuration. The lockout window is
// validated server-side; the client cannot lie about its attempt
// counter. After the window passes, the next correct attempt
// succeeds and resets failed_attempts.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	// MaxFailedAttempts is how many wrong PIN entries trigger the
	// lockout window.
	MaxFailedAttempts = 3
	// LockoutDuration is how long the lockout lasts after
	// MaxFailedAttempts wrong entries.
	LockoutDuration = 60 * time.Second
	// SessionTTL is how long an unlock token survives without a
	// refresh. The kid client refreshes on every menu close so
	// consecutive edits don't re-prompt.
	SessionTTL = 60 * time.Second
	// PINBcryptCost is the bcrypt cost factor for the PIN. 12 is
	// generous for a 4-digit PIN; the verify path runs ~30ms which
	// is fine for a parent-typed entry.
	PINBcryptCost = 12
)

var (
	// ErrPINNotSet is returned when verify is called before any PIN
	// has been configured.
	ErrPINNotSet = errors.New("override PIN not set")
	// ErrPINIncorrect is returned for a wrong attempt that DID NOT
	// trip the lockout. Attempt counter has been incremented.
	ErrPINIncorrect = errors.New("override PIN incorrect")
	// ErrPINLockedOut is returned when the caller is currently in
	// the lockout window. The error message includes seconds-until-
	// unlock so the UI can render a countdown without a separate
	// IsLockedOut probe.
	ErrPINLockedOut = errors.New("override PIN locked out")
	// ErrOverrideSessionInvalid is returned by ValidateSession when
	// the kid has no active session, the token doesn't match, or
	// the session has expired.
	ErrOverrideSessionInvalid = errors.New("override session invalid")
)

// OverrideStatus is the singleton row's relevant state for the
// admin settings UI. PINSet is true when a hash has been written;
// LockedFor is non-zero only while inside the lockout window.
type OverrideStatus struct {
	PINSet         bool
	FailedAttempts int
	LockedFor      time.Duration
	UpdatedAt      time.Time
}

// GetOverrideStatus returns the current configuration view.
func (s *Store) GetOverrideStatus(ctx context.Context) (*OverrideStatus, error) {
	var (
		hash         sql.NullString
		failed       int
		lockedUntil  int64
		updatedAt    int64
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT pin_hash, failed_attempts, locked_until, updated_at
		FROM override_config WHERE id = 1`).
		Scan(&hash, &failed, &lockedUntil, &updatedAt)
	if err != nil {
		return nil, err
	}
	out := &OverrideStatus{
		PINSet:         scanNullableString(hash) != "",
		FailedAttempts: failed,
		UpdatedAt:      time.Unix(updatedAt, 0),
	}
	if lockedUntil > 0 {
		until := time.Unix(lockedUntil, 0)
		if rem := time.Until(until); rem > 0 {
			out.LockedFor = rem
		}
	}
	return out, nil
}

// SetPIN bcrypts the plaintext + writes it. Empty plaintext clears
// the PIN (the override modal will refuse to mint sessions without
// a PIN configured, which is the documented "no override" mode).
func (s *Store) SetPIN(ctx context.Context, plaintext string) error {
	if plaintext == "" {
		_, err := s.db.ExecContext(ctx, `
			UPDATE override_config
			SET pin_hash = NULL,
			    failed_attempts = 0,
			    locked_until = 0,
			    updated_at = unixepoch()
			WHERE id = 1`)
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(plaintext), PINBcryptCost)
	if err != nil {
		return fmt.Errorf("hash pin: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE override_config
		SET pin_hash = ?,
		    failed_attempts = 0,
		    locked_until = 0,
		    updated_at = unixepoch()
		WHERE id = 1`, string(hash))
	return err
}

// VerifyPIN compares the candidate against the stored hash. On
// success the attempt counter is cleared. On failure the counter
// is bumped and, if it crosses MaxFailedAttempts, the lockout is
// stamped; subsequent calls return ErrPINLockedOut until the
// window passes.
//
// The "is the caller currently locked out" check happens before
// the bcrypt comparison so a flood of attempts can't keep the
// lockout perpetually active by costing CPU each call.
func (s *Store) VerifyPIN(ctx context.Context, plaintext string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var (
		hash        sql.NullString
		failed      int
		lockedUntil int64
	)
	if err := tx.QueryRowContext(ctx, `
		SELECT pin_hash, failed_attempts, locked_until
		FROM override_config WHERE id = 1`).
		Scan(&hash, &failed, &lockedUntil); err != nil {
		return err
	}
	if scanNullableString(hash) == "" {
		return ErrPINNotSet
	}
	if lockedUntil > 0 && time.Now().Before(time.Unix(lockedUntil, 0)) {
		return ErrPINLockedOut
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash.String), []byte(plaintext)); err != nil {
		failed++
		newLock := lockedUntil
		if failed >= MaxFailedAttempts {
			newLock = time.Now().Add(LockoutDuration).Unix()
			failed = 0 // reset so the next attempt after the window doesn't trigger another lock immediately
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE override_config
			SET failed_attempts = ?,
			    locked_until = ?,
			    updated_at = unixepoch()
			WHERE id = 1`, failed, newLock); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		if newLock > lockedUntil {
			return ErrPINLockedOut
		}
		return ErrPINIncorrect
	}
	// Correct PIN. Reset attempt counter + lock.
	if _, err := tx.ExecContext(ctx, `
		UPDATE override_config
		SET failed_attempts = 0,
		    locked_until = 0,
		    updated_at = unixepoch()
		WHERE id = 1`); err != nil {
		return err
	}
	return tx.Commit()
}

// --- per-kid override sessions ----------------------------------------

// OverrideSession is the result of MintSession. Token is the raw
// token to hand to the kid client; ExpiresAt is when it stops
// validating without a refresh.
type OverrideSession struct {
	Token     string
	ExpiresAt time.Time
}

// MintSession creates (or replaces) the kid's active session.
// Caller is responsible for verifying the PIN first.
func (s *Store) MintSession(ctx context.Context, kidID int64) (*OverrideSession, error) {
	if kidID <= 0 {
		return nil, errors.New("kidID required")
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	hash := hashOverrideToken(token)
	expires := time.Now().Add(SessionTTL)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO kid_override_sessions (kid_id, token_hash, expires_at, created_at, last_used)
		VALUES (?, ?, ?, unixepoch(), unixepoch())
		ON CONFLICT(kid_id) DO UPDATE SET
		    token_hash = excluded.token_hash,
		    expires_at = excluded.expires_at,
		    created_at = excluded.created_at,
		    last_used  = excluded.last_used`,
		kidID, hash, expires.Unix())
	if err != nil {
		return nil, err
	}
	return &OverrideSession{Token: token, ExpiresAt: expires}, nil
}

// ValidateSession checks the kid + token pair against the row;
// returns ErrOverrideSessionInvalid when no row, hash mismatch, or
// expired. last_used is bumped on success.
func (s *Store) ValidateSession(ctx context.Context, kidID int64, token string) error {
	if kidID <= 0 || token == "" {
		return ErrOverrideSessionInvalid
	}
	hash := hashOverrideToken(token)
	var (
		stored  string
		expires int64
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT token_hash, expires_at
		FROM kid_override_sessions WHERE kid_id = ?`, kidID).
		Scan(&stored, &expires)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrOverrideSessionInvalid
		}
		return err
	}
	if stored != hash {
		return ErrOverrideSessionInvalid
	}
	if time.Now().After(time.Unix(expires, 0)) {
		return ErrOverrideSessionInvalid
	}
	_, _ = s.db.ExecContext(ctx, `
		UPDATE kid_override_sessions SET last_used = unixepoch() WHERE kid_id = ?`, kidID)
	return nil
}

// RefreshSession bumps expires_at by SessionTTL when (kid, token)
// matches. The kid client calls this on every override-menu close
// so consecutive edits don't re-prompt for the PIN.
func (s *Store) RefreshSession(ctx context.Context, kidID int64, token string) (*OverrideSession, error) {
	if err := s.ValidateSession(ctx, kidID, token); err != nil {
		return nil, err
	}
	expires := time.Now().Add(SessionTTL)
	if _, err := s.db.ExecContext(ctx, `
		UPDATE kid_override_sessions SET expires_at = ?, last_used = unixepoch() WHERE kid_id = ?`,
		expires.Unix(), kidID); err != nil {
		return nil, err
	}
	return &OverrideSession{Token: token, ExpiresAt: expires}, nil
}

// EndSession drops the kid's row. Idempotent.
func (s *Store) EndSession(ctx context.Context, kidID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM kid_override_sessions WHERE kid_id = ?`, kidID)
	return err
}

// hashOverrideToken hashes a token with sha256 for storage. Same
// shape as the API key path; bcrypt is overkill here because the
// token is high-entropy + short-lived.
func hashOverrideToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// --- audit log --------------------------------------------------------

// RecordOverrideAction appends to the audit log. Action is one of
// the documented strings (favorite_add, favorite_remove, tag_set,
// hide, mark_played, mark_unplayed, qr_view); we don't enforce a
// CHECK constraint at the schema level so admins can extend by
// adding new action codes without a migration.
func (s *Store) RecordOverrideAction(ctx context.Context, kidID int64, action, targetID, payloadJSON string) error {
	var kidArg any
	if kidID > 0 {
		kidArg = kidID
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO override_actions (kid_id, action, target_id, payload, performed_at)
		VALUES (?, ?, ?, ?, unixepoch())`,
		kidArg, action, targetID, nullableString(payloadJSON))
	return err
}

// --- generic app settings --------------------------------------------

// AppSettingGet returns the value for a key. Empty string when not
// set (or the row's value is empty). Use AppSettingExists when the
// distinction between "unset" and "set to empty" matters.
func (s *Store) AppSettingGet(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx,
		`SELECT value FROM app_settings WHERE key = ?`, key).Scan(&v)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return v, nil
}

// AppSettingSet upserts a key + value.
func (s *Store) AppSettingSet(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO app_settings (key, value, updated_at)
		VALUES (?, ?, unixepoch())
		ON CONFLICT(key) DO UPDATE SET
		    value = excluded.value,
		    updated_at = excluded.updated_at`,
		key, value)
	return err
}

// AppSettingExists is the "is the key in the table?" probe; useful
// for distinguishing "intentionally cleared" from "never set."
func (s *Store) AppSettingExists(ctx context.Context, key string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM app_settings WHERE key = ?`, key).Scan(&n)
	return n > 0, err
}

// --- catalog version (t60) -------------------------------------------
//
// catalog_version is a monotonic counter folded into every kid-facing
// ETag (Library, Browse, Tags, TagDetail) so a parent-side curation
// mutation (or an itemcache refresh delta) invalidates the kid's
// sessionStorage / IDB caches automatically. Bump points live in the
// curation Store layer (one bump per write API, batched APIs bump
// once) so handlers don't have to know about cache invalidation.
//
// The counter is stored in app_settings under key "catalog_version"
// as a base-10 string. Reads return 0 when the row hasn't been
// initialized yet (fresh DB, never bumped); that's fine - the ETag
// still composes deterministically and the next bump produces a new
// value.
//
// catalog_version is intentionally NOT in settings_registry's
// admin-writable list; bumps are server-internal. It is registered so
// admin tooling can read it for debugging.

// BumpCatalogVersion increments the global catalog_version counter.
// Idempotent at the SQL level: one UPSERT, no read-modify-write. Safe
// to call inside or outside a transaction (callers in this package
// hook it after their transaction commits to keep the bump out of the
// hot SQLite WAL path).
func (s *Store) BumpCatalogVersion(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO app_settings (key, value, updated_at)
		VALUES ('catalog_version', '1', unixepoch())
		ON CONFLICT(key) DO UPDATE SET
		    value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
		    updated_at = unixepoch()`)
	return err
}

// bumpCatalog is the swallowing variant used by mutation paths in
// this package. A bump failure must not cascade into the caller's
// error path: the mutation already succeeded, and a missed bump just
// means kids see slightly-stale data until the next mutation. The
// alternative (returning the bump error) would roll back the mutation
// from the caller's perspective, which is the wrong trade-off.
func (s *Store) bumpCatalog(ctx context.Context) {
	_ = s.BumpCatalogVersion(ctx)
}

// CatalogVersion reads the current value. Returns 0 when the key is
// not yet present (no mutations since the DB was created).
func (s *Store) CatalogVersion(ctx context.Context) (int64, error) {
	v, err := s.AppSettingGet(ctx, "catalog_version")
	if err != nil {
		return 0, err
	}
	if v == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, nil
	}
	return n, nil
}

package curation

// API key storage layer (M14). Bearer-token auth equivalent to the
// admin cookie. The auth middleware accepts a key via the
// `Authorization: Bearer <token>` header; we verify the sha256 hash
// and bump last_used_at on each successful call. Revoke is a flag
// (revoked_at IS NOT NULL); we keep the row so historical access-log
// entries continue to point at a known name.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// APIKey is one row of api_keys. TokenHash is sha256(plaintext) hex.
// Plaintext is only ever returned by Create at issuance time and
// surfaced through CreatedToken on the result; we never persist it.
type APIKey struct {
	ID         int64
	Name       string
	TokenHash  string
	CreatedAt  time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
}

// CreatedAPIKey is the result of CreateAPIKey - the raw token plus
// the persisted row. Callers display the token to the admin once
// and warn them to copy it; we can't reproduce it from the hash.
type CreatedAPIKey struct {
	Token string
	Key   APIKey
}

// APIAccessLogEntry is one row of api_access_log. KeyID is nullable
// (the key may have been deleted after the access). Path is the raw
// URL path, no query string - we don't want to log secrets that may
// have leaked into query params.
type APIAccessLogEntry struct {
	ID         int64
	KeyID      *int64
	Method     string
	Path       string
	Status     int
	OccurredAt time.Time
}

var (
	// ErrAPIKeyNotFound is returned by Get/Update/Revoke when the id
	// doesn't exist.
	ErrAPIKeyNotFound = errors.New("api key not found")
	// ErrAPIKeyInvalid is returned by VerifyAPIKey for unknown,
	// revoked, or malformed tokens. We collapse all three into one
	// error so callers don't accidentally leak which case happened.
	ErrAPIKeyInvalid = errors.New("api key invalid")
)

// generateToken returns a fresh `jb_<64 hex>` token. The prefix lets
// admins eyeball that a string is a Jellybean token; the body is
// 32 bytes of crypto/rand turned into 64 hex chars (~256 bits of
// entropy). Format change is allowed - just bump the prefix and
// document.
func generateToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("rand: %w", err)
	}
	return "jb_" + hex.EncodeToString(buf), nil
}

// hashToken returns sha256(token) as a lowercase hex string. Same
// hash function on issue + verify.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// CreateAPIKey issues a new token, stores its hash, and returns
// both the plaintext (so the admin can copy it) and the stored row.
func (s *Store) CreateAPIKey(ctx context.Context, name string) (*CreatedAPIKey, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("api key name required")
	}
	token, err := generateToken()
	if err != nil {
		return nil, err
	}
	hash := hashToken(token)
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO api_keys (name, token_hash, created_at)
		VALUES (?, ?, unixepoch())`, name, hash)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	row, err := s.GetAPIKey(ctx, id)
	if err != nil {
		return nil, err
	}
	return &CreatedAPIKey{Token: token, Key: *row}, nil
}

// GetAPIKey fetches one row by id. ErrAPIKeyNotFound on miss.
func (s *Store) GetAPIKey(ctx context.Context, id int64) (*APIKey, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, token_hash, created_at, last_used_at, revoked_at
		FROM api_keys WHERE id = ?`, id)
	return scanAPIKey(row)
}

// ListAPIKeys returns every row, ordered by created_at desc so the
// admin sees the most-recently-issued first.
func (s *Store) ListAPIKeys(ctx context.Context) ([]APIKey, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, token_hash, created_at, last_used_at, revoked_at
		FROM api_keys ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []APIKey
	for rows.Next() {
		var (
			k                APIKey
			created          int64
			lastUsed, revoked sql.NullInt64
		)
		if err := rows.Scan(&k.ID, &k.Name, &k.TokenHash, &created, &lastUsed, &revoked); err != nil {
			return nil, err
		}
		k.CreatedAt = time.Unix(created, 0)
		if lastUsed.Valid {
			t := time.Unix(lastUsed.Int64, 0)
			k.LastUsedAt = &t
		}
		if revoked.Valid {
			t := time.Unix(revoked.Int64, 0)
			k.RevokedAt = &t
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// RevokeAPIKey stamps revoked_at; verify will then reject the token.
// Idempotent.
func (s *Store) RevokeAPIKey(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE api_keys SET revoked_at = unixepoch()
		WHERE id = ? AND revoked_at IS NULL`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// either not found or already revoked; check which
		if _, err := s.GetAPIKey(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// DeleteAPIKey hard-deletes a row. Admins can revoke (preserving the
// row + its history) or delete (the api_access_log rows have key_id
// SET NULL so the access entries survive).
func (s *Store) DeleteAPIKey(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM api_keys WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrAPIKeyNotFound
	}
	return nil
}

// VerifyAPIKey looks up a token, returning the row when valid, or
// ErrAPIKeyInvalid when:
//   - token is empty / wrong shape
//   - hash doesn't match any row
//   - matched row is revoked
//
// Caller is responsible for calling UpdateAPIKeyLastUsed after a
// successful verify (we don't bake it in so the verify path stays
// read-only and faster).
func (s *Store) VerifyAPIKey(ctx context.Context, token string) (*APIKey, error) {
	if !strings.HasPrefix(token, "jb_") {
		return nil, ErrAPIKeyInvalid
	}
	hash := hashToken(token)
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, token_hash, created_at, last_used_at, revoked_at
		FROM api_keys WHERE token_hash = ?`, hash)
	k, err := scanAPIKey(row)
	if err != nil {
		if errors.Is(err, ErrAPIKeyNotFound) {
			return nil, ErrAPIKeyInvalid
		}
		return nil, err
	}
	if k.RevokedAt != nil {
		return nil, ErrAPIKeyInvalid
	}
	return k, nil
}

// UpdateAPIKeyLastUsed bumps last_used_at to now. Called after a
// successful Verify.
func (s *Store) UpdateAPIKeyLastUsed(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?`, id)
	return err
}

// LogAPIAccess records one successful bearer-authed call. The auth
// middleware fires this in a goroutine so it doesn't block the hot
// path. We use a short context detached from the request's so a
// cancel on the request doesn't kill the log write.
func (s *Store) LogAPIAccess(keyID int64, method, path string, status int) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = s.db.ExecContext(ctx, `
			INSERT INTO api_access_log (key_id, method, path, status, occurred_at)
			VALUES (?, ?, ?, ?, unixepoch())`, keyID, method, path, status)
	}()
}

// ListAPIAccessLog returns recent entries, optionally filtered to one
// key. Pass keyID = 0 for "all keys."
func (s *Store) ListAPIAccessLog(ctx context.Context, keyID int64, limit, offset int) ([]APIAccessLogEntry, error) {
	if limit <= 0 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	var (
		rows *sql.Rows
		err  error
	)
	if keyID > 0 {
		rows, err = s.db.QueryContext(ctx, `
			SELECT id, key_id, method, path, status, occurred_at
			FROM api_access_log WHERE key_id = ?
			ORDER BY occurred_at DESC, id DESC
			LIMIT ? OFFSET ?`, keyID, limit, offset)
	} else {
		rows, err = s.db.QueryContext(ctx, `
			SELECT id, key_id, method, path, status, occurred_at
			FROM api_access_log
			ORDER BY occurred_at DESC, id DESC
			LIMIT ? OFFSET ?`, limit, offset)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []APIAccessLogEntry
	for rows.Next() {
		var (
			e   APIAccessLogEntry
			kid sql.NullInt64
			at  int64
		)
		if err := rows.Scan(&e.ID, &kid, &e.Method, &e.Path, &e.Status, &at); err != nil {
			return nil, err
		}
		if kid.Valid {
			id := kid.Int64
			e.KeyID = &id
		}
		e.OccurredAt = time.Unix(at, 0)
		out = append(out, e)
	}
	return out, rows.Err()
}

func scanAPIKey(row *sql.Row) (*APIKey, error) {
	var (
		k                 APIKey
		created           int64
		lastUsed, revoked sql.NullInt64
	)
	if err := row.Scan(&k.ID, &k.Name, &k.TokenHash, &created, &lastUsed, &revoked); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrAPIKeyNotFound
		}
		return nil, err
	}
	k.CreatedAt = time.Unix(created, 0)
	if lastUsed.Valid {
		t := time.Unix(lastUsed.Int64, 0)
		k.LastUsedAt = &t
	}
	if revoked.Valid {
		t := time.Unix(revoked.Int64, 0)
		k.RevokedAt = &t
	}
	return &k, nil
}

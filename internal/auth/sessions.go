// Package auth handles parent login (delegated to Jellyfin), session
// management, and request authentication for /api/admin routes.
//
// Sessions are stored in SQLite. The cookie carries a random opaque token;
// the database stores HMAC(secret, token) so the value at rest cannot be
// trivially used to authenticate, and rotating JELLYBEAN_SESSION_SECRET
// invalidates every active session at once.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

const (
	tokenBytes      = 32
	SessionDuration = 7 * 24 * time.Hour
)

// Session is a row from the sessions table.
type Session struct {
	UserID     string
	UserName   string
	CreatedAt  time.Time
	LastSeenAt time.Time
}

// SessionStore persists sessions and looks them up by cookie token. Tokens are
// HMAC'd with the configured secret before being stored or queried, so the
// raw cookie value never lands in the database.
type SessionStore struct {
	db     *sql.DB
	secret []byte
}

func NewSessionStore(db *sql.DB, secret string) *SessionStore {
	return &SessionStore{db: db, secret: []byte(secret)}
}

// Create returns a new opaque token (the value the cookie should carry) and
// inserts the corresponding session row.
func (s *SessionStore) Create(ctx context.Context, userID, userName string) (string, error) {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	token := hex.EncodeToString(raw)
	hash := s.hash(token)
	now := time.Now().Unix()
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions (token_hash, user_id, user_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
		hash, userID, userName, now, now)
	if err != nil {
		return "", fmt.Errorf("insert session: %w", err)
	}
	return token, nil
}

// ErrSessionNotFound is returned by Get when the token is unknown, expired, or
// signed with a different secret.
var ErrSessionNotFound = errors.New("session not found")

// Get looks up a session by its cookie token. Updates last_seen_at when the
// session is found and current. Returns ErrSessionNotFound if the token does
// not match a live session.
func (s *SessionStore) Get(ctx context.Context, token string) (*Session, error) {
	if token == "" {
		return nil, ErrSessionNotFound
	}
	hash := s.hash(token)
	row := s.db.QueryRowContext(ctx, `SELECT user_id, user_name, created_at, last_seen_at FROM sessions WHERE token_hash = ?`, hash)
	var (
		userID, userName       string
		createdAt, lastSeenAt int64
	)
	if err := row.Scan(&userID, &userName, &createdAt, &lastSeenAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrSessionNotFound
		}
		return nil, err
	}
	cutoff := time.Now().Add(-SessionDuration).Unix()
	if lastSeenAt < cutoff {
		_, _ = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, hash)
		return nil, ErrSessionNotFound
	}
	now := time.Now().Unix()
	if now-lastSeenAt > 60 { // amortize writes
		_, _ = s.db.ExecContext(ctx, `UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`, now, hash)
	}
	return &Session{
		UserID:     userID,
		UserName:   userName,
		CreatedAt:  time.Unix(createdAt, 0),
		LastSeenAt: time.Unix(lastSeenAt, 0),
	}, nil
}

// Delete invalidates a session.
func (s *SessionStore) Delete(ctx context.Context, token string) error {
	hash := s.hash(token)
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, hash)
	return err
}

// PurgeExpired removes sessions older than the cutoff. Safe to call on a
// schedule; not required for correctness (Get also self-cleans on lookup).
func (s *SessionStore) PurgeExpired(ctx context.Context) error {
	cutoff := time.Now().Add(-SessionDuration).Unix()
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE last_seen_at < ?`, cutoff)
	return err
}

func (s *SessionStore) hash(token string) string {
	h := hmac.New(sha256.New, s.secret)
	h.Write([]byte(token))
	return hex.EncodeToString(h.Sum(nil))
}

package curation

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// PairSession is one in-flight phone-pairing handshake.
//
// The kid TV mints one of these, the parent's phone completes it by
// posting Jellyfin credentials to /pair/<short_code>/submit, the TV's
// /poll lifts the resulting Jellyfin auth out of it. See the package
// docs in pair.go for the higher-level flow.
type PairSession struct {
	ShortCode        string
	PollingToken     string
	Status           string // pending | complete | expired
	CreatedAt        time.Time
	ExpiresAt        time.Time
	CompletedAt      *time.Time
	JellyfinUserID   string
	JellyfinUserName string
	JellyfinToken    string
	DeviceID         string
}

var (
	ErrPairNotFound = errors.New("pair session not found")
	ErrPairExpired  = errors.New("pair session expired")
)

// CreatePairSession inserts a new pending session.
func (s *Store) CreatePairSession(ctx context.Context, p PairSession) error {
	if p.ShortCode == "" || p.PollingToken == "" {
		return errors.New("shortCode and pollingToken required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO pair_sessions
			(short_code, polling_token, status, created_at, expires_at, device_id)
		VALUES (?, ?, 'pending', ?, ?, ?)`,
		p.ShortCode, p.PollingToken, p.CreatedAt.Unix(), p.ExpiresAt.Unix(), p.DeviceID)
	return err
}

// GetPairByShortCode is the lookup used by the phone-side page (parent
// just typed the URL via QR scan; we need the row to render the form
// and to validate POSTs).
func (s *Store) GetPairByShortCode(ctx context.Context, shortCode string) (*PairSession, error) {
	shortCode = strings.TrimSpace(shortCode)
	if shortCode == "" {
		return nil, ErrPairNotFound
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT short_code, polling_token, status, created_at, expires_at,
		       completed_at, jellyfin_user_id, jellyfin_user_name, jellyfin_token, device_id
		FROM pair_sessions
		WHERE short_code = ?`, shortCode)
	return scanPairSession(row)
}

// GetPairByPollingToken is the lookup used by the TV's poll. The TV
// holds the pollingToken in memory and never exposes the short code on
// the wire after the QR is rendered.
func (s *Store) GetPairByPollingToken(ctx context.Context, token string) (*PairSession, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrPairNotFound
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT short_code, polling_token, status, created_at, expires_at,
		       completed_at, jellyfin_user_id, jellyfin_user_name, jellyfin_token, device_id
		FROM pair_sessions
		WHERE polling_token = ?`, token)
	return scanPairSession(row)
}

// CompletePairSession is called by the phone-side submit handler after
// AuthenticateByName succeeds. Sets status=complete and stashes the
// Jellyfin auth result. Idempotent: a second call with the same short
// code is rejected via ErrPairExpired (someone is fishing).
func (s *Store) CompletePairSession(
	ctx context.Context,
	shortCode string,
	jellyfinUserID string,
	jellyfinUserName string,
	jellyfinToken string,
) error {
	now := time.Now()
	res, err := s.db.ExecContext(ctx, `
		UPDATE pair_sessions
		SET status = 'complete',
		    completed_at = ?,
		    jellyfin_user_id = ?,
		    jellyfin_user_name = ?,
		    jellyfin_token = ?
		WHERE short_code = ?
		  AND status = 'pending'
		  AND expires_at > ?`,
		now.Unix(), jellyfinUserID, jellyfinUserName, jellyfinToken, shortCode, now.Unix())
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrPairExpired
	}
	return nil
}

// PrunePairSessions deletes rows whose expires_at has passed. The
// server runs this periodically; it's not on the request path. Returns
// the number of rows removed.
func (s *Store) PrunePairSessions(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM pair_sessions WHERE expires_at <= ?`, now.Unix())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// IsExpired returns true when this session is past its TTL. Both the
// poll and the submit handlers consult this so a slow-typing parent
// doesn't accidentally complete a TTL'd row that's still in the table
// because the janitor hasn't run yet.
func (p *PairSession) IsExpired(now time.Time) bool {
	return now.After(p.ExpiresAt)
}

func scanPairSession(row *sql.Row) (*PairSession, error) {
	var (
		p             PairSession
		createdAt     int64
		expiresAt     int64
		completedAt   sql.NullInt64
		jfUserID      sql.NullString
		jfUserName    sql.NullString
		jfToken       sql.NullString
		deviceID      sql.NullString
	)
	if err := row.Scan(
		&p.ShortCode,
		&p.PollingToken,
		&p.Status,
		&createdAt,
		&expiresAt,
		&completedAt,
		&jfUserID,
		&jfUserName,
		&jfToken,
		&deviceID,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrPairNotFound
		}
		return nil, err
	}
	p.CreatedAt = time.Unix(createdAt, 0)
	p.ExpiresAt = time.Unix(expiresAt, 0)
	if completedAt.Valid {
		t := time.Unix(completedAt.Int64, 0)
		p.CompletedAt = &t
	}
	if jfUserID.Valid {
		p.JellyfinUserID = jfUserID.String
	}
	if jfUserName.Valid {
		p.JellyfinUserName = jfUserName.String
	}
	if jfToken.Valid {
		p.JellyfinToken = jfToken.String
	}
	if deviceID.Valid {
		p.DeviceID = deviceID.String
	}
	return &p, nil
}

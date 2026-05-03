package curation

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

// Kid represents a child profile that a TV authenticates as.
type Kid struct {
	ID             int64
	Name           string
	ProfileID      int64
	JellyfinUserID string
	HasToken       bool
	CreatedAt      time.Time
}

// KidWithProfile decorates Kid with the profile name for listing UIs that
// don't want to do a join in JS.
type KidWithProfile struct {
	Kid
	ProfileName string
}

var (
	ErrKidNotFound      = errors.New("kid not found")
	ErrKidUserCollision = errors.New("a kid for that Jellyfin user already exists")
)

// ListKids returns all kids with their profile name.
func (s *Store) ListKids(ctx context.Context) ([]KidWithProfile, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT k.id, k.name, k.profile_id, k.jellyfin_user_id,
		       (k.jellyfin_token IS NOT NULL AND k.jellyfin_token != '') AS has_token,
		       k.created_at, p.name
		FROM kids k
		JOIN profiles p ON p.id = k.profile_id
		ORDER BY k.created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []KidWithProfile
	for rows.Next() {
		var (
			k        KidWithProfile
			hasToken int
			ts       int64
		)
		if err := rows.Scan(&k.ID, &k.Name, &k.ProfileID, &k.JellyfinUserID, &hasToken, &ts, &k.ProfileName); err != nil {
			return nil, err
		}
		k.HasToken = hasToken != 0
		k.CreatedAt = time.Unix(ts, 0)
		out = append(out, k)
	}
	return out, rows.Err()
}

// GetKid fetches one kid by ID, or ErrKidNotFound.
func (s *Store) GetKid(ctx context.Context, id int64) (*KidWithProfile, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT k.id, k.name, k.profile_id, k.jellyfin_user_id,
		       (k.jellyfin_token IS NOT NULL AND k.jellyfin_token != ''),
		       k.created_at, p.name
		FROM kids k
		JOIN profiles p ON p.id = k.profile_id
		WHERE k.id = ?`, id)
	var (
		k        KidWithProfile
		hasToken int
		ts       int64
	)
	if err := row.Scan(&k.ID, &k.Name, &k.ProfileID, &k.JellyfinUserID, &hasToken, &ts, &k.ProfileName); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrKidNotFound
		}
		return nil, err
	}
	k.HasToken = hasToken != 0
	k.CreatedAt = time.Unix(ts, 0)
	return &k, nil
}

// FindKidByAPIKey looks a kid up by the raw API key the TV presents in the
// X-Jellybean-Key header. Hashes the input before querying so the raw value
// never lands in the DB or in the query.
//
// Returns ErrKidNotFound if no row matches; surfacing different errors for
// "didn't match" vs "DB unreachable" lets callers respond with 401 vs 500.
func (s *Store) FindKidByAPIKey(ctx context.Context, rawKey string) (*KidEntry, error) {
	if rawKey == "" {
		return nil, ErrKidNotFound
	}
	hash := hashAPIKey(rawKey)
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, profile_id, jellyfin_user_id, COALESCE(jellyfin_token, '')
		FROM kids WHERE api_key_hash = ?`, hash)
	var k KidEntry
	if err := row.Scan(&k.ID, &k.Name, &k.ProfileID, &k.JellyfinUserID, &k.JellyfinToken); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrKidNotFound
		}
		return nil, err
	}
	return &k, nil
}

// KidEntry is the lookup result used by the streaming auth path. It carries
// the Jellyfin token so the stream URL can be signed with the right user's
// credentials.
type KidEntry struct {
	ID             int64
	Name           string
	ProfileID      int64
	JellyfinUserID string
	JellyfinToken  string
}

// CreateKidParams is the input to CreateKid. JellyfinToken is the token
// minted via AuthenticateByName; the kid's password itself is never stored.
type CreateKidParams struct {
	Name           string
	ProfileID      int64
	JellyfinUserID string
	JellyfinToken  string
}

// CreateKidResult bundles the persisted Kid plus the raw API key the parent
// must copy into the kid's TV. The raw key is shown exactly once and never
// retrievable again from the server.
type CreateKidResult struct {
	Kid       *KidWithProfile
	RawAPIKey string
}

// CreateKid persists a kid row and returns it together with a freshly
// generated API key. Caller is responsible for having already validated
// the Jellyfin token via the jellyfin client (we don't redo it here).
func (s *Store) CreateKid(ctx context.Context, p CreateKidParams) (*CreateKidResult, error) {
	name := strings.TrimSpace(p.Name)
	if name == "" {
		return nil, fmt.Errorf("kid name required")
	}
	if p.JellyfinUserID == "" {
		return nil, fmt.Errorf("jellyfin user id required")
	}
	rawKey, err := generateAPIKey()
	if err != nil {
		return nil, err
	}
	hash := hashAPIKey(rawKey)

	res, err := s.db.ExecContext(ctx, `
		INSERT INTO kids (name, profile_id, jellyfin_user_id, jellyfin_token, api_key_hash, created_at)
		VALUES (?, ?, ?, ?, ?, unixepoch())`,
		name, p.ProfileID, p.JellyfinUserID, nullableString(p.JellyfinToken), hash)
	if err != nil {
		// SQLite UNIQUE constraint surface as a plain error string; map to
		// our typed error so handlers can return 409.
		if strings.Contains(err.Error(), "UNIQUE constraint failed: kids.jellyfin_user_id") {
			return nil, ErrKidUserCollision
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	kid, err := s.GetKid(ctx, id)
	if err != nil {
		return nil, err
	}
	return &CreateKidResult{Kid: kid, RawAPIKey: rawKey}, nil
}

// RegenerateAPIKey replaces the kid's API key. The Jellyfin token is left
// in place; only the on-TV credential rotates.
func (s *Store) RegenerateAPIKey(ctx context.Context, id int64) (string, error) {
	rawKey, err := generateAPIKey()
	if err != nil {
		return "", err
	}
	hash := hashAPIKey(rawKey)
	res, err := s.db.ExecContext(ctx, `UPDATE kids SET api_key_hash = ? WHERE id = ?`, hash, id)
	if err != nil {
		return "", err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return "", ErrKidNotFound
	}
	return rawKey, nil
}

// UpdateKidProfile moves a kid to a different profile. The kid's API key
// and Jellyfin token stay the same; only the visibility scope shifts.
// Returns ErrKidNotFound when the row is missing.
func (s *Store) UpdateKidProfile(ctx context.Context, id int64, profileID int64) error {
	if profileID <= 0 {
		return fmt.Errorf("profileId required")
	}
	// Confirm the target profile exists so we surface a clean 4xx instead
	// of a foreign-key violation later.
	if _, err := s.GetProfile(ctx, profileID); err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE kids SET profile_id = ? WHERE id = ?`, profileID, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrKidNotFound
	}
	return nil
}

// DeleteKid removes the row. Token revocation against Jellyfin is not
// performed; the token will keep working at Jellyfin until it expires
// naturally or the parent revokes it through Jellyfin's admin UI.
func (s *Store) DeleteKid(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM kids WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrKidNotFound
	}
	return nil
}

// generateAPIKey returns 32 random bytes hex-encoded (64 chars). That's
// enough entropy that a brute-force attempt against the api_key_hash is
// not realistic.
func generateAPIKey() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// hashAPIKey is the storage / lookup hash for kid API keys. SHA-256 with
// no salt is sufficient because the input is high-entropy random; a salt
// would not meaningfully raise the bar for an attacker who has the table
// dump.
func hashAPIKey(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

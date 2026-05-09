package curation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Kid represents a child's mapping from a Jellyfin user to a Jellybean
// curation profile. The TV / mobile app authenticates with Jellyfin
// directly (via Jellybean's /api/kids/auth/login proxy); Jellybean does
// not store passwords or long-lived tokens. This row is purely the
// "which profile do I scope this Jellyfin user's library to" record.
type Kid struct {
	ID             int64
	Name           string
	ProfileID      int64
	JellyfinUserID string
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
		SELECT k.id, k.name, k.profile_id, k.jellyfin_user_id, k.created_at, p.name
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
			k  KidWithProfile
			ts int64
		)
		if err := rows.Scan(&k.ID, &k.Name, &k.ProfileID, &k.JellyfinUserID, &ts, &k.ProfileName); err != nil {
			return nil, err
		}
		k.CreatedAt = time.Unix(ts, 0)
		out = append(out, k)
	}
	return out, rows.Err()
}

// GetKid fetches one kid by ID, or ErrKidNotFound.
func (s *Store) GetKid(ctx context.Context, id int64) (*KidWithProfile, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT k.id, k.name, k.profile_id, k.jellyfin_user_id, k.created_at, p.name
		FROM kids k
		JOIN profiles p ON p.id = k.profile_id
		WHERE k.id = ?`, id)
	var (
		k  KidWithProfile
		ts int64
	)
	if err := row.Scan(&k.ID, &k.Name, &k.ProfileID, &k.JellyfinUserID, &ts, &k.ProfileName); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrKidNotFound
		}
		return nil, err
	}
	k.CreatedAt = time.Unix(ts, 0)
	return &k, nil
}

// FindFirstKidByProfile returns the oldest kid associated with the
// given profile id, or ErrKidNotFound when the profile has no kids.
// Used by the admin-preview override flow to "act as" a kid when
// the admin user isn't mapped to one - lets the parent test the
// override gesture from a browser without needing a real kid login.
func (s *Store) FindFirstKidByProfile(ctx context.Context, profileID int64) (*KidWithProfile, error) {
	if profileID <= 0 {
		return nil, ErrKidNotFound
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT k.id, k.name, k.profile_id, k.jellyfin_user_id, k.created_at, p.name
		FROM kids k
		JOIN profiles p ON p.id = k.profile_id
		WHERE k.profile_id = ?
		ORDER BY k.created_at ASC
		LIMIT 1`, profileID)
	var (
		k  KidWithProfile
		ts int64
	)
	if err := row.Scan(&k.ID, &k.Name, &k.ProfileID, &k.JellyfinUserID, &ts, &k.ProfileName); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrKidNotFound
		}
		return nil, err
	}
	k.CreatedAt = time.Unix(ts, 0)
	return &k, nil
}

// FindKidByJellyfinUser is the auth-path lookup: the TV's bearer token
// belongs to this Jellyfin user; which kid (and therefore which profile)
// should we scope their library to?
func (s *Store) FindKidByJellyfinUser(ctx context.Context, jellyfinUserID string) (*KidWithProfile, error) {
	if jellyfinUserID == "" {
		return nil, ErrKidNotFound
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT k.id, k.name, k.profile_id, k.jellyfin_user_id, k.created_at, p.name
		FROM kids k
		JOIN profiles p ON p.id = k.profile_id
		WHERE k.jellyfin_user_id = ?`, jellyfinUserID)
	var (
		k  KidWithProfile
		ts int64
	)
	if err := row.Scan(&k.ID, &k.Name, &k.ProfileID, &k.JellyfinUserID, &ts, &k.ProfileName); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrKidNotFound
		}
		return nil, err
	}
	k.CreatedAt = time.Unix(ts, 0)
	return &k, nil
}

// CreateKidParams is the input to CreateKid. No password, no token; the
// admin only ever supplies a Jellyfin user id picked from a list.
type CreateKidParams struct {
	Name           string
	ProfileID      int64
	JellyfinUserID string
}

// CreateKid persists a kid row mapping a Jellyfin user to a profile.
func (s *Store) CreateKid(ctx context.Context, p CreateKidParams) (*KidWithProfile, error) {
	name := strings.TrimSpace(p.Name)
	if name == "" {
		return nil, fmt.Errorf("kid name required")
	}
	if p.JellyfinUserID == "" {
		return nil, fmt.Errorf("jellyfin user id required")
	}
	if p.ProfileID <= 0 {
		return nil, fmt.Errorf("profile id required")
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO kids (name, profile_id, jellyfin_user_id, created_at)
		VALUES (?, ?, ?, unixepoch())`,
		name, p.ProfileID, p.JellyfinUserID)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: kids.jellyfin_user_id") {
			return nil, ErrKidUserCollision
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetKid(ctx, id)
}

// UpdateKid mutates name and/or profile_id. Empty name leaves it; zero
// profile_id leaves it.
func (s *Store) UpdateKid(ctx context.Context, id int64, name string, profileID int64) error {
	name = strings.TrimSpace(name)
	if name == "" && profileID <= 0 {
		return fmt.Errorf("nothing to update")
	}
	if profileID > 0 {
		if _, err := s.GetProfile(ctx, profileID); err != nil {
			return err
		}
	}
	var (
		res sql.Result
		err error
	)
	switch {
	case name != "" && profileID > 0:
		res, err = s.db.ExecContext(ctx,
			`UPDATE kids SET name = ?, profile_id = ? WHERE id = ?`,
			name, profileID, id)
	case name != "":
		res, err = s.db.ExecContext(ctx,
			`UPDATE kids SET name = ? WHERE id = ?`, name, id)
	default:
		res, err = s.db.ExecContext(ctx,
			`UPDATE kids SET profile_id = ? WHERE id = ?`, profileID, id)
	}
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrKidNotFound
	}
	return nil
}

// UpdateKidProfile is a thin wrapper around UpdateKid for callers that
// only want to change profile_id. Kept for clarity at call sites.
func (s *Store) UpdateKidProfile(ctx context.Context, id, profileID int64) error {
	if profileID <= 0 {
		return fmt.Errorf("profileId required")
	}
	return s.UpdateKid(ctx, id, "", profileID)
}

// DeleteKid removes the row.
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

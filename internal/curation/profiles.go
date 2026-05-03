package curation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Profile is the unit of per-profile visibility. Each kid is assigned to a
// profile; the kid-stream filter shows only items marked visible for that
// profile. Profiles in v1 are a label and a description; visibility lives
// in the categorizations table, not here.
type Profile struct {
	ID          int64
	Name        string
	Description string
	CreatedAt   time.Time
}

// ProfileWithKidCount is what the listing endpoint returns; the count is
// useful in the UI for "this profile has 3 kids assigned" hints and to
// guard delete actions.
type ProfileWithKidCount struct {
	Profile
	KidCount int
}

// ErrProfileNotFound is returned when a profile lookup or update misses.
var ErrProfileNotFound = errors.New("profile not found")

// ErrProfileInUse is returned when a delete is rejected because kids still
// reference the profile.
var ErrProfileInUse = errors.New("profile has kids assigned; reassign first")

// ErrProfileProtected covers the immutable "Default" profile.
var ErrProfileProtected = errors.New("default profile cannot be deleted")

// ListProfiles returns all profiles with their current kid counts.
func (s *Store) ListProfiles(ctx context.Context) ([]ProfileWithKidCount, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT p.id, p.name, COALESCE(p.description, ''), p.created_at,
		       (SELECT COUNT(*) FROM kids WHERE profile_id = p.id)
		FROM profiles p
		ORDER BY p.id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ProfileWithKidCount
	for rows.Next() {
		var (
			p  ProfileWithKidCount
			ts int64
		)
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &ts, &p.KidCount); err != nil {
			return nil, err
		}
		p.CreatedAt = time.Unix(ts, 0)
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetProfile fetches one profile by ID. Returns ErrProfileNotFound if none.
func (s *Store) GetProfile(ctx context.Context, id int64) (*Profile, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, COALESCE(description, ''), created_at
		FROM profiles WHERE id = ?`, id)
	var (
		p  Profile
		ts int64
	)
	if err := row.Scan(&p.ID, &p.Name, &p.Description, &ts); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrProfileNotFound
		}
		return nil, err
	}
	p.CreatedAt = time.Unix(ts, 0)
	return &p, nil
}

// ProfileInput is the mutation payload for create / update.
type ProfileInput struct {
	Name        string
	Description string
}

// CreateProfile inserts a profile. Name is trimmed and required; uniqueness
// is enforced by the schema's UNIQUE constraint.
func (s *Store) CreateProfile(ctx context.Context, in ProfileInput) (*Profile, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("profile name required")
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO profiles (name, description, created_at)
		VALUES (?, ?, unixepoch())`,
		name, nullableString(in.Description))
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetProfile(ctx, id)
}

// UpdateProfile applies a full mutation. Returns ErrProfileNotFound if the
// row doesn't exist.
func (s *Store) UpdateProfile(ctx context.Context, id int64, in ProfileInput) (*Profile, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("profile name required")
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE profiles
		SET name = ?, description = ?
		WHERE id = ?`,
		name, nullableString(in.Description), id)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrProfileNotFound
	}
	return s.GetProfile(ctx, id)
}

// DeleteProfile removes a profile. The Default profile is protected; any
// profile with kids assigned is also protected (caller must reassign first).
func (s *Store) DeleteProfile(ctx context.Context, id int64) error {
	p, err := s.GetProfile(ctx, id)
	if err != nil {
		return err
	}
	if p.Name == "Default" {
		return ErrProfileProtected
	}
	var n int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM kids WHERE profile_id = ?`, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrProfileInUse
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM profiles WHERE id = ?`, id)
	return err
}

// nullableString returns nil for an empty string so the column is set to
// SQL NULL rather than an empty string.
func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

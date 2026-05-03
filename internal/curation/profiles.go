package curation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Profile is a content-rule abstraction kids belong to. v1 carries an age
// range; future milestones may add genre / studio filters.
type Profile struct {
	ID          int64
	Name        string
	Description string
	MinAge      int
	MaxAge      int
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
		SELECT p.id, p.name, COALESCE(p.description, ''), p.min_age, p.max_age, p.created_at,
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
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.MinAge, &p.MaxAge, &ts, &p.KidCount); err != nil {
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
		SELECT id, name, COALESCE(description, ''), min_age, max_age, created_at
		FROM profiles WHERE id = ?`, id)
	var (
		p  Profile
		ts int64
	)
	if err := row.Scan(&p.ID, &p.Name, &p.Description, &p.MinAge, &p.MaxAge, &ts); err != nil {
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
	MinAge      int
	MaxAge      int
}

// validateAgeRange enforces a sensible profile range. Anything outside
// [0..99] is rejected; max must be >= min.
func validateAgeRange(minAge, maxAge int) error {
	if minAge < 0 || minAge > 99 || maxAge < 0 || maxAge > 99 {
		return fmt.Errorf("age range must be within 0..99")
	}
	if maxAge < minAge {
		return fmt.Errorf("max age (%d) must be >= min age (%d)", maxAge, minAge)
	}
	return nil
}

// CreateProfile inserts a profile. Name is trimmed and required; uniqueness
// is enforced by the schema's UNIQUE constraint. The age range defaults to
// 0..18 if the caller didn't set explicit values (caller passes their
// preferred values via ProfileInput).
func (s *Store) CreateProfile(ctx context.Context, in ProfileInput) (*Profile, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("profile name required")
	}
	if in.MaxAge == 0 && in.MinAge == 0 {
		in.MaxAge = 18
	}
	if err := validateAgeRange(in.MinAge, in.MaxAge); err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO profiles (name, description, min_age, max_age, created_at)
		VALUES (?, ?, ?, ?, unixepoch())`,
		name, nullableString(in.Description), in.MinAge, in.MaxAge)
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
	if err := validateAgeRange(in.MinAge, in.MaxAge); err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE profiles
		SET name = ?, description = ?, min_age = ?, max_age = ?
		WHERE id = ?`,
		name, nullableString(in.Description), in.MinAge, in.MaxAge, id)
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

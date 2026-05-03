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
	ID              int64
	Name            string
	Description     string
	DefaultLanguage string // ISO 639-3 (e.g. "eng"); matches Jellyfin MediaStream.Language
	CreatedAt       time.Time
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
		SELECT p.id, p.name, COALESCE(p.description, ''), p.default_language, p.created_at,
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
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.DefaultLanguage, &ts, &p.KidCount); err != nil {
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
		SELECT id, name, COALESCE(description, ''), default_language, created_at
		FROM profiles WHERE id = ?`, id)
	var (
		p  Profile
		ts int64
	)
	if err := row.Scan(&p.ID, &p.Name, &p.Description, &p.DefaultLanguage, &ts); err != nil {
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
	Name            string
	Description     string
	DefaultLanguage string // ISO 639-3; empty means "leave existing value" on update or default to "eng" on create
	// BaseProfileID is honored by CreateProfile only. When > 0, the new
	// profile copies every categorization row from the named source so
	// the user can start from "what we already decided for sibling X"
	// instead of an empty slate.
	BaseProfileID int64
}

// CreateProfile inserts a profile. Name is trimmed and required; uniqueness
// is enforced by the schema's UNIQUE constraint. When BaseProfileID is
// set, every categorization row from the source profile is duplicated
// into the new profile so the user starts from a meaningful baseline.
func (s *Store) CreateProfile(ctx context.Context, in ProfileInput) (*Profile, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("profile name required")
	}
	lang := normalizeLanguage(in.DefaultLanguage)
	if lang == "" {
		lang = "eng"
	}
	// Confirm base exists (when supplied) before we create the new row;
	// keeps the error path clean.
	if in.BaseProfileID > 0 {
		if _, err := s.GetProfile(ctx, in.BaseProfileID); err != nil {
			return nil, err
		}
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO profiles (name, description, default_language, created_at)
		VALUES (?, ?, ?, unixepoch())`,
		name, nullableString(in.Description), lang)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	if in.BaseProfileID > 0 {
		if _, err := s.CopyCategorizations(ctx, in.BaseProfileID, id); err != nil {
			return nil, fmt.Errorf("copy from base profile: %w", err)
		}
	}
	return s.GetProfile(ctx, id)
}

// UpdateProfile applies a full mutation. Returns ErrProfileNotFound if the
// row doesn't exist.
func (s *Store) UpdateProfile(ctx context.Context, id int64, in ProfileInput) (*Profile, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("profile name required")
	}
	lang := normalizeLanguage(in.DefaultLanguage)
	var (
		res sql.Result
		err error
	)
	if lang == "" {
		// Leave default_language untouched.
		res, err = s.db.ExecContext(ctx, `
			UPDATE profiles
			SET name = ?, description = ?
			WHERE id = ?`,
			name, nullableString(in.Description), id)
	} else {
		res, err = s.db.ExecContext(ctx, `
			UPDATE profiles
			SET name = ?, description = ?, default_language = ?
			WHERE id = ?`,
			name, nullableString(in.Description), lang, id)
	}
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrProfileNotFound
	}
	return s.GetProfile(ctx, id)
}

// normalizeLanguage trims, lower-cases, and validates that the language
// looks like a 2- or 3-letter code. Empty / invalid → empty string.
func normalizeLanguage(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return ""
	}
	if len(s) < 2 || len(s) > 3 {
		return ""
	}
	for _, r := range s {
		if r < 'a' || r > 'z' {
			return ""
		}
	}
	return s
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

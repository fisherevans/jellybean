package db

import (
	"testing"
)

func TestMigrationsApplyAndDefaultProfileExists(t *testing.T) {
	conn, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer conn.Close()

	row := conn.QueryRow(`SELECT name FROM profiles WHERE name = 'Default'`)
	var name string
	if err := row.Scan(&name); err != nil {
		t.Fatalf("default profile lookup: %v", err)
	}
	if name != "Default" {
		t.Errorf("name = %q, want Default", name)
	}
}

func TestMigrationsAreIdempotent(t *testing.T) {
	conn, err := Open(":memory:")
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	// Re-running migrate on the same connection must not duplicate the
	// default profile or fail.
	if err := migrate(conn); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	row := conn.QueryRow(`SELECT COUNT(*) FROM profiles WHERE name = 'Default'`)
	var n int
	if err := row.Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("Default profile count = %d, want 1", n)
	}
	conn.Close()
}

func TestCategorizationsTableSchema(t *testing.T) {
	conn, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	// Reject invalid category values via the CHECK constraint.
	_, err = conn.Exec(`INSERT INTO categorizations
		(jellyfin_item_id, category, source, set_at, set_by)
		VALUES ('abc', 'bogus', 'manual', 0, 'admin')`)
	if err == nil {
		t.Error("expected CHECK constraint to reject invalid category")
	}

	// Reject invalid source values.
	_, err = conn.Exec(`INSERT INTO categorizations
		(jellyfin_item_id, category, source, set_at, set_by)
		VALUES ('abc', 'kid', 'bogus', 0, 'admin')`)
	if err == nil {
		t.Error("expected CHECK constraint to reject invalid source")
	}

	// Valid insert succeeds.
	_, err = conn.Exec(`INSERT INTO categorizations
		(jellyfin_item_id, category, source, set_at, set_by)
		VALUES ('abc', 'kid', 'manual', unixepoch(), 'admin')`)
	if err != nil {
		t.Errorf("valid insert failed: %v", err)
	}
}

func TestKidsTableUniqueConstraints(t *testing.T) {
	conn, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	exec := func(q string, args ...any) error {
		_, err := conn.Exec(q, args...)
		return err
	}

	if err := exec(`INSERT INTO kids
		(name, profile_id, jellyfin_user_id, api_key_hash, created_at)
		VALUES ('alice', 1, 'jf-1', 'hash-1', unixepoch())`); err != nil {
		t.Fatalf("first kid: %v", err)
	}

	// Duplicate jellyfin_user_id rejected.
	if err := exec(`INSERT INTO kids
		(name, profile_id, jellyfin_user_id, api_key_hash, created_at)
		VALUES ('alice2', 1, 'jf-1', 'hash-2', unixepoch())`); err == nil {
		t.Error("expected duplicate jellyfin_user_id to fail")
	}

	// Duplicate api_key_hash rejected.
	if err := exec(`INSERT INTO kids
		(name, profile_id, jellyfin_user_id, api_key_hash, created_at)
		VALUES ('bob', 1, 'jf-2', 'hash-1', unixepoch())`); err == nil {
		t.Error("expected duplicate api_key_hash to fail")
	}
}

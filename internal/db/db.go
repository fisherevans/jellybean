// Package db owns the SQLite connection and migration runner for Jellybean.
//
// Schema lives in the top-level migrations/ directory and is embedded into the
// binary at build time. The migration runner applies any files whose ordering
// number has not yet been recorded in schema_migrations. Migrations are never
// re-run, never reordered, never edited after the fact.
package db

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open creates the SQLite connection, enables foreign keys + WAL, and runs any
// pending migrations. Safe to call once at startup.
func Open(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)", path)
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if err := conn.Ping(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if err := migrate(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return conn, nil
}

func migrate(conn *sql.DB) error {
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		return err
	}

	applied := map[string]bool{}
	rows, err := conn.Query(`SELECT version FROM schema_migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()

	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("read embedded migrations: %w", err)
	}

	var files []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		files = append(files, e.Name())
	}
	sort.Strings(files)

	for _, f := range files {
		version := strings.TrimSuffix(f, ".sql")
		if applied[version] {
			continue
		}
		body, err := migrationsFS.ReadFile("migrations/" + f)
		if err != nil {
			return fmt.Errorf("read %s: %w", f, err)
		}
		tx, err := conn.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply %s: %w", f, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, unixepoch())`, version); err != nil {
			tx.Rollback()
			return fmt.Errorf("record %s: %w", f, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

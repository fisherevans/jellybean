package auth

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/fisherevans/jellybean/internal/db"
)

func openTestDB(t *testing.T) (*sql.DB, *SessionStore) {
	t.Helper()
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn, NewSessionStore(conn, "test-secret")
}

func TestSessionCreateAndGet(t *testing.T) {
	_, store := openTestDB(t)
	ctx := context.Background()

	tok, err := store.Create(ctx, "user1", "Alice")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if tok == "" {
		t.Fatal("empty token")
	}

	sess, err := store.Get(ctx, tok)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if sess.UserID != "user1" || sess.UserName != "Alice" {
		t.Errorf("unexpected session: %+v", sess)
	}
}

func TestSessionGetUnknown(t *testing.T) {
	_, store := openTestDB(t)
	_, err := store.Get(context.Background(), "garbage")
	if !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("expected ErrSessionNotFound, got %v", err)
	}
}

func TestSessionDelete(t *testing.T) {
	_, store := openTestDB(t)
	ctx := context.Background()

	tok, _ := store.Create(ctx, "u", "n")
	if err := store.Delete(ctx, tok); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := store.Get(ctx, tok); !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("expected ErrSessionNotFound after delete, got %v", err)
	}
}

func TestSessionRotateSecret(t *testing.T) {
	conn, store := openTestDB(t)
	ctx := context.Background()

	tok, _ := store.Create(ctx, "u", "n")

	// Same DB, new secret: token should no longer validate.
	rotated := NewSessionStore(conn, "different-secret")
	if _, err := rotated.Get(ctx, tok); !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("expected secret rotation to invalidate session, got %v", err)
	}
}

func TestRateLimiter(t *testing.T) {
	rl := NewRateLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		if !rl.Allow("ip1") {
			t.Errorf("attempt %d should be allowed", i+1)
		}
	}
	if rl.Allow("ip1") {
		t.Error("4th attempt should be blocked")
	}
	if !rl.Allow("ip2") {
		t.Error("different IP should not be affected")
	}
	rl.Reset("ip1")
	if !rl.Allow("ip1") {
		t.Error("reset should clear the budget")
	}
}

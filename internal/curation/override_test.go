package curation

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestOverridePINNotSetInitially(t *testing.T) {
	_, store, _ := openStore(t)
	st, err := store.GetOverrideStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.PINSet {
		t.Errorf("fresh DB should report PIN not set")
	}
	if err := store.VerifyPIN(context.Background(), "1234"); !errors.Is(err, ErrPINNotSet) {
		t.Errorf("verify with no PIN -> %v, want ErrPINNotSet", err)
	}
}

func TestOverridePINSetVerifyClearReverify(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()

	if err := store.SetPIN(ctx, "1234"); err != nil {
		t.Fatal(err)
	}
	st, _ := store.GetOverrideStatus(ctx)
	if !st.PINSet {
		t.Errorf("after set, PINSet should be true")
	}

	if err := store.VerifyPIN(ctx, "1234"); err != nil {
		t.Errorf("correct PIN -> %v", err)
	}
	if err := store.VerifyPIN(ctx, "wrong"); !errors.Is(err, ErrPINIncorrect) {
		t.Errorf("wrong PIN -> %v, want ErrPINIncorrect", err)
	}

	// Clear.
	if err := store.SetPIN(ctx, ""); err != nil {
		t.Fatal(err)
	}
	st, _ = store.GetOverrideStatus(ctx)
	if st.PINSet {
		t.Errorf("after clear, PINSet should be false")
	}
}

func TestOverrideLockoutAfterMaxAttempts(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()
	if err := store.SetPIN(ctx, "1234"); err != nil {
		t.Fatal(err)
	}
	// Two wrong attempts: still ErrPINIncorrect.
	for i := 0; i < MaxFailedAttempts-1; i++ {
		if err := store.VerifyPIN(ctx, "wrong"); !errors.Is(err, ErrPINIncorrect) {
			t.Errorf("attempt %d -> %v, want ErrPINIncorrect", i+1, err)
		}
	}
	// Final attempt trips the lockout.
	if err := store.VerifyPIN(ctx, "wrong"); !errors.Is(err, ErrPINLockedOut) {
		t.Errorf("trip attempt -> %v, want ErrPINLockedOut", err)
	}
	// Subsequent attempt during lockout: even correct PIN returns
	// locked-out.
	if err := store.VerifyPIN(ctx, "1234"); !errors.Is(err, ErrPINLockedOut) {
		t.Errorf("during lockout -> %v, want ErrPINLockedOut", err)
	}
	st, _ := store.GetOverrideStatus(ctx)
	if st.LockedFor <= 0 {
		t.Errorf("LockedFor should be positive while locked")
	}
}

func TestOverrideSessionMintValidateRefreshEnd(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()
	kid, err := store.CreateKid(ctx, CreateKidParams{
		Name: "Ollie", ProfileID: 1, JellyfinUserID: "user-ollie",
	})
	if err != nil {
		t.Fatal(err)
	}

	sess, err := store.MintSession(ctx, kid.ID)
	if err != nil {
		t.Fatal(err)
	}
	if sess.Token == "" || sess.ExpiresAt.Before(time.Now()) {
		t.Errorf("mint produced invalid session: %+v", sess)
	}

	if err := store.ValidateSession(ctx, kid.ID, sess.Token); err != nil {
		t.Errorf("validate fresh session -> %v", err)
	}
	if err := store.ValidateSession(ctx, kid.ID, "garbage"); !errors.Is(err, ErrOverrideSessionInvalid) {
		t.Errorf("validate wrong token -> %v, want ErrOverrideSessionInvalid", err)
	}

	refreshed, err := store.RefreshSession(ctx, kid.ID, sess.Token)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed.ExpiresAt.After(sess.ExpiresAt) && !refreshed.ExpiresAt.Equal(sess.ExpiresAt) {
		t.Errorf("refresh did not extend expiry: %v -> %v", sess.ExpiresAt, refreshed.ExpiresAt)
	}

	if err := store.EndSession(ctx, kid.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateSession(ctx, kid.ID, sess.Token); !errors.Is(err, ErrOverrideSessionInvalid) {
		t.Errorf("validate after end -> %v, want ErrOverrideSessionInvalid", err)
	}
}

func TestOverrideAuditLog(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()
	kid, _ := store.CreateKid(ctx, CreateKidParams{
		Name: "Ollie", ProfileID: 1, JellyfinUserID: "user-ollie",
	})
	if err := store.RecordOverrideAction(ctx, kid.ID, "favorite_add", "movie-1", `{"src":"override"}`); err != nil {
		t.Fatal(err)
	}
	// Confirm the row landed.
	var n int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM override_actions WHERE kid_id = ? AND action = ?`,
		kid.ID, "favorite_add").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("audit row count = %d, want 1", n)
	}
}

func TestAppSettingsRoundTrip(t *testing.T) {
	_, store, _ := openStore(t)
	ctx := context.Background()
	v, err := store.AppSettingGet(ctx, "public_url")
	if err != nil {
		t.Fatal(err)
	}
	if v != "" {
		t.Errorf("seeded public_url should be empty, got %q", v)
	}
	if err := store.AppSettingSet(ctx, "public_url", "https://example.com"); err != nil {
		t.Fatal(err)
	}
	v, _ = store.AppSettingGet(ctx, "public_url")
	if v != "https://example.com" {
		t.Errorf("AppSettingSet did not stick: %q", v)
	}
}

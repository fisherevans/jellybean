package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOptionalMiddlewareNoCookie(t *testing.T) {
	_, store := openTestDB(t)
	h := &Handlers{Sessions: store}

	called := false
	handler := h.OptionalMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if SessionFromContext(r.Context()) != nil {
			t.Error("expected nil session in context when no cookie")
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Error("downstream handler should still run when no cookie present")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestOptionalMiddlewareValidCookie(t *testing.T) {
	_, store := openTestDB(t)
	h := &Handlers{Sessions: store}

	tok, err := store.Create(context.Background(), "u1", "Alice")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	handler := h.OptionalMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess := SessionFromContext(r.Context())
		if sess == nil {
			t.Error("expected session in context")
		} else if sess.UserID != "u1" {
			t.Errorf("UserID = %s, want u1", sess.UserID)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: tok})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d", rec.Code)
	}
}

func TestOptionalMiddlewareGarbageCookie(t *testing.T) {
	_, store := openTestDB(t)
	h := &Handlers{Sessions: store}

	handler := h.OptionalMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Garbage cookie should be silently ignored - downstream still runs,
		// just without a session.
		if SessionFromContext(r.Context()) != nil {
			t.Error("expected nil session for invalid cookie")
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "this-is-not-a-real-token"})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 (garbage cookie ignored)", rec.Code)
	}
}

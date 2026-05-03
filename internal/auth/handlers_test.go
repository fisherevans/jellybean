package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

func newHandlers(t *testing.T, jellyfinHandler http.HandlerFunc) (*Handlers, *httptest.Server) {
	t.Helper()
	jfSrv := httptest.NewServer(jellyfinHandler)
	t.Cleanup(jfSrv.Close)

	_, store := openTestDB(t)
	return &Handlers{
		Sessions:      store,
		Jellyfin:      jellyfin.New(jfSrv.URL, "service-key"),
		Logger:        zerolog.Nop(),
		RateLimit:     NewRateLimiter(5, time.Minute),
		SecureCookies: false,
	}, jfSrv
}

func TestLoginSuccess(t *testing.T) {
	h, _ := newHandlers(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jellyfin.AuthResult{
			AccessToken: "tok",
			User: jellyfin.AuthUser{
				ID: "u1", Name: "Alice",
				Policy: jellyfin.UserPolicy{IsAdministrator: true},
			},
		})
	})

	body, _ := json.Marshal(loginRequest{Username: "alice", Password: "hunter2"})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	req.RemoteAddr = "1.2.3.4:1234"
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 || cookies[0].Name != cookieName {
		t.Fatalf("expected session cookie, got %v", cookies)
	}
	if cookies[0].Value == "" {
		t.Error("session cookie has empty value")
	}
}

func TestLoginInvalidCredentials(t *testing.T) {
	h, _ := newHandlers(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})

	body, _ := json.Marshal(loginRequest{Username: "alice", Password: "wrong"})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	req.RemoteAddr = "1.2.3.4:1234"
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d", rec.Code)
	}
}

func TestLoginNonAdminRejected(t *testing.T) {
	h, _ := newHandlers(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jellyfin.AuthResult{
			AccessToken: "tok",
			User: jellyfin.AuthUser{
				ID: "u1", Name: "Bob",
				Policy: jellyfin.UserPolicy{IsAdministrator: false},
			},
		})
	})

	body, _ := json.Marshal(loginRequest{Username: "bob", Password: "x"})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	req.RemoteAddr = "1.2.3.4:1234"
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rec.Code)
	}
}

func TestRateLimit(t *testing.T) {
	h, _ := newHandlers(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	h.RateLimit = NewRateLimiter(2, time.Minute)

	for i := 0; i < 2; i++ {
		body, _ := json.Marshal(loginRequest{Username: "x", Password: "x"})
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
		req.RemoteAddr = "1.2.3.4:1234"
		rec := httptest.NewRecorder()
		h.Login(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d", i+1, rec.Code)
		}
	}

	body, _ := json.Marshal(loginRequest{Username: "x", Password: "x"})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	req.RemoteAddr = "1.2.3.4:1234"
	rec := httptest.NewRecorder()
	h.Login(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", rec.Code)
	}
}

func TestMiddlewareGatesUnauth(t *testing.T) {
	h, _ := newHandlers(t, func(w http.ResponseWriter, r *http.Request) {})
	protected := h.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/admin/anything", nil)
	rec := httptest.NewRecorder()
	protected.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestFullFlow(t *testing.T) {
	h, _ := newHandlers(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jellyfin.AuthResult{
			AccessToken: "tok",
			User: jellyfin.AuthUser{
				ID: "u1", Name: "Alice",
				Policy: jellyfin.UserPolicy{IsAdministrator: true},
			},
		})
	})

	// Login
	body, _ := json.Marshal(loginRequest{Username: "alice", Password: "x"})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	req.RemoteAddr = "1.2.3.4:1234"
	rec := httptest.NewRecorder()
	h.Login(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	cookie := rec.Result().Cookies()[0]

	// /me with cookie
	req = httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	h.Middleware(http.HandlerFunc(h.Me)).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("me: %d %s", rec.Code, rec.Body.String())
	}
	var ur userResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &ur)
	if ur.Name != "Alice" {
		t.Errorf("Name = %s", ur.Name)
	}

	// Logout
	req = httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	h.Logout(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("logout: %d", rec.Code)
	}

	// Cookie should be expired now; /me must 401
	req = httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	h.Middleware(http.HandlerFunc(h.Me)).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("me after logout: %d", rec.Code)
	}
}

func TestSessionFromContext(t *testing.T) {
	if SessionFromContext(context.Background()) != nil {
		t.Error("expected nil session for empty context")
	}
}
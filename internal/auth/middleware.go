package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

type ctxKey int

const (
	sessionKey ctxKey = 1
	apiKeyKey  ctxKey = 2
)

// SessionFromContext returns the session attached by Middleware, or nil if
// the request was not authenticated.
func SessionFromContext(ctx context.Context) *Session {
	s, _ := ctx.Value(sessionKey).(*Session)
	return s
}

// APIKeyContext is the metadata attached when a request was
// authenticated via a bearer API key (M14). Handlers don't usually
// need to distinguish between cookie- and key-authed requests; the
// admin-action paths treat both as "authenticated as admin." But the
// access log writer needs the key id, and `sessionUserID` callers
// want a sensible fallback label.
type APIKeyContext struct {
	ID   int64
	Name string
}

// APIKeyFromContext returns the API key the request was authed with,
// or nil if the request used cookie auth (or wasn't authenticated).
func APIKeyFromContext(ctx context.Context) *APIKeyContext {
	k, _ := ctx.Value(apiKeyKey).(*APIKeyContext)
	return k
}

// BearerVerifier is the interface the API-key verifier must implement.
// internal/curation.Store satisfies it; we declare the interface here
// so the auth package doesn't import curation. The auth/curation
// dependency direction stays one-way (curation -> auth via Sessions
// store; auth -> verifier interface only).
type BearerVerifier interface {
	VerifyBearer(ctx context.Context, token string) (*APIKeyContext, error)
	NoteBearerUsed(keyID int64, method, path string, status int)
}

// Middleware gates downstream handlers on a valid session cookie OR
// a valid API-key bearer token. On failure returns 401. On success,
// attaches the session (cookie path) or APIKeyContext (bearer path)
// to the request context.
//
// Cookie path is checked first because every interactive admin
// browser session uses it; the bearer path is for headless callers
// (LLM, scripts) and only fires when no cookie is present (or the
// cookie is invalid).
func (h *Handlers) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 1. Cookie path.
		if c, err := r.Cookie(cookieName); err == nil && c.Value != "" {
			sess, err := h.Sessions.Get(r.Context(), c.Value)
			if err == nil {
				ctx := context.WithValue(r.Context(), sessionKey, sess)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			if !errors.Is(err, ErrSessionNotFound) {
				h.Logger.Error().Err(err).Msg("session lookup")
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
			// Fall through to bearer check on session-not-found.
		}

		// 2. Bearer / API-key path.
		if h.Bearer != nil {
			if tok, ok := bearerToken(r); ok {
				key, err := h.Bearer.VerifyBearer(r.Context(), tok)
				if err == nil && key != nil {
					ctx := context.WithValue(r.Context(), apiKeyKey, key)
					// Wrap response writer so we can log the
					// status the handler returned. The bearer
					// implementation writes async so this never
					// blocks.
					rw := &statusRecorder{ResponseWriter: w, code: 200}
					next.ServeHTTP(rw, r.WithContext(ctx))
					h.Bearer.NoteBearerUsed(key.ID, r.Method, r.URL.Path, rw.code)
					return
				}
			}
		}

		http.Error(w, "unauthenticated", http.StatusUnauthorized)
	})
}

// bearerToken extracts the token from `Authorization: Bearer <token>`.
// Empty / wrong-scheme returns ok=false; the verifier rejects empty
// tokens too, but the early bail keeps the verify call out of the hot
// path on cookie-auth requests.
func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	if h == "" {
		return "", false
	}
	parts := strings.SplitN(h, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", false
	}
	tok := strings.TrimSpace(parts[1])
	if tok == "" {
		return "", false
	}
	return tok, true
}

// statusRecorder wraps an http.ResponseWriter so the bearer middleware
// can capture the final response code for the access log.
type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

// OptionalMiddleware attaches the session to the context if a valid cookie is
// present but does not 401 when one is missing. Used on routes (like the
// kids API) that have a secondary auth path; the handler decides what to
// do with `SessionFromContext(ctx) == nil`.
func (h *Handlers) OptionalMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err == nil && c.Value != "" {
			sess, err := h.Sessions.Get(r.Context(), c.Value)
			if err == nil {
				ctx := context.WithValue(r.Context(), sessionKey, sess)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

package auth

import (
	"context"
	"errors"
	"net/http"
)

type ctxKey int

const sessionKey ctxKey = 1

// SessionFromContext returns the session attached by Middleware, or nil if
// the request was not authenticated.
func SessionFromContext(ctx context.Context) *Session {
	s, _ := ctx.Value(sessionKey).(*Session)
	return s
}

// Middleware gates downstream handlers on a valid session cookie. On failure
// returns 401 with no body. On success, attaches the session to the request
// context for handlers to inspect.
func (h *Handlers) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err != nil || c.Value == "" {
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		sess, err := h.Sessions.Get(r.Context(), c.Value)
		if err != nil {
			if errors.Is(err, ErrSessionNotFound) {
				http.Error(w, "unauthenticated", http.StatusUnauthorized)
				return
			}
			h.Logger.Error().Err(err).Msg("session lookup")
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		ctx := context.WithValue(r.Context(), sessionKey, sess)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

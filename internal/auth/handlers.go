package auth

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

const (
	cookieName = "jellybean_session"
)

// Handlers holds the auth-related HTTP handlers and exports a middleware for
// gating /api/admin/* routes.
type Handlers struct {
	Sessions   *SessionStore
	Jellyfin   *jellyfin.Client
	Logger     zerolog.Logger
	RateLimit  *RateLimiter
	SecureCookies bool // set true in production (HTTPS only)
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type userResponse struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Admin bool   `json:"admin"`
}

func (h *Handlers) Login(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !h.RateLimit.Allow(ip) {
		http.Error(w, "too many attempts, try again later", http.StatusTooManyRequests)
		return
	}

	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Username == "" || req.Password == "" {
		http.Error(w, "username and password required", http.StatusBadRequest)
		return
	}

	res, err := h.Jellyfin.AuthenticateByName(r.Context(), req.Username, req.Password)
	if err != nil {
		if jellyfin.IsUnauthorized(err) {
			h.Logger.Info().Str("user", req.Username).Str("ip", ip).Msg("login failed")
			http.Error(w, "invalid credentials", http.StatusUnauthorized)
			return
		}
		h.Logger.Error().Err(err).Msg("jellyfin auth error")
		http.Error(w, "auth backend error", http.StatusBadGateway)
		return
	}
	if !res.User.Policy.IsAdministrator {
		h.Logger.Info().Str("user", req.Username).Msg("non-admin login denied")
		http.Error(w, "admin role required", http.StatusForbidden)
		return
	}

	token, err := h.Sessions.Create(r.Context(), res.User.ID, res.User.Name)
	if err != nil {
		h.Logger.Error().Err(err).Msg("create session")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	h.RateLimit.Reset(ip)
	h.setCookie(w, token, SessionDuration)

	writeJSON(w, http.StatusOK, userResponse{
		ID:    res.User.ID,
		Name:  res.User.Name,
		Admin: res.User.Policy.IsAdministrator,
	})
}

func (h *Handlers) Logout(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(cookieName)
	if err == nil && c.Value != "" {
		_ = h.Sessions.Delete(r.Context(), c.Value)
	}
	h.setCookie(w, "", -time.Hour)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) Me(w http.ResponseWriter, r *http.Request) {
	sess := SessionFromContext(r.Context())
	if sess == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, userResponse{
		ID:    sess.UserID,
		Name:  sess.UserName,
		Admin: true, // we only persist admin sessions
	})
}

func (h *Handlers) setCookie(w http.ResponseWriter, value string, ttl time.Duration) {
	c := &http.Cookie{
		Name:     cookieName,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.SecureCookies,
	}
	if ttl > 0 {
		c.Expires = time.Now().Add(ttl)
		c.MaxAge = int(ttl.Seconds())
	} else {
		c.MaxAge = -1
	}
	http.SetCookie(w, c)
}

// clientIP returns a best-effort source IP for rate limiting. Honors
// X-Forwarded-For when present (Cloudflare tunnel sets this).
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.Index(xff, ","); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}


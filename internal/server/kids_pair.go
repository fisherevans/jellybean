package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// Phone-pairing login flow. Distinct from Jellyfin Quick Connect:
// this flow lets the parent enter the kid's Jellyfin password on
// their phone (via password manager) without needing a signed-in
// Jellyfin session anywhere else.
//
// Flow:
//
//  1. TV calls POST /api/kids/auth/pair/start. Server mints a 6-char
//     human-friendly short code (rendered in a QR), an opaque polling
//     token (kept on the TV, never on the wire as a path component),
//     and persists a pending row in pair_sessions.
//  2. TV displays /pair/<short_code> as a QR. TV starts polling
//     GET /api/kids/auth/pair/poll?token=<polling_token>.
//  3. Parent scans QR, browser opens GET /pair/<short_code>: server
//     renders an HTML form with username + password fields posting
//     back to /pair/<short_code>/submit.
//  4. Parent submits. Server calls Jellyfin AuthenticateByName, looks
//     up the kid mapping (mirrors handleKidsLogin's gates), and on
//     success marks the row complete + stashes the Jellyfin token.
//  5. TV's next poll sees status=complete, server returns the same
//     KidLoginResponse shape as /api/kids/auth/login. TV seals the
//     session and navigates into the app.
//
// Server-rendered HTML (not a separate Vite bundle) for the phone
// page: it's one form, doesn't justify another build target. Inline
// CSS so it works without depending on either SPA's bundle.
//
// Pair sessions live in SQLite (see internal/db/migrations/0003)
// because the parent typing on a phone keyboard can take longer than
// any reasonable in-process state should outlive a server restart.

const (
	pairTTL          = 7 * time.Minute
	pairCompletedTTL = 30 * time.Second // window after complete to keep row reachable for re-poll
	pairShortCodeLen = 6
)

// pairAlphabet is the ambiguity-stripped set we draw short codes from.
// Excludes 0/O/1/I/L so a parent reading the QR's printed text
// fallback doesn't second-guess characters.
const pairAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

// pairSubmitLimiter rate-limits POST /pair/<code>/submit by source
// IP. The phone form is unauthenticated so a brute-forcer who scrapes
// short codes (long-shot - 31^6 ≈ 887M) shouldn't be able to spray
// passwords against Jellyfin via Jellybean. 5 attempts per 5 minutes
// per IP is generous for a real human typo + tight enough that the
// short-code space stays effectively closed.
//
// Lives in this file (not a singleton on Server) so the existing
// auth.RateLimiter on the admin login isn't shared - we don't want a
// burst of phone-pair attempts to lock out the admin login or vice
// versa.
type pairSubmitLimiter struct {
	mu      sync.Mutex
	hits    map[string][]time.Time
	max     int
	window  time.Duration
}

func newPairSubmitLimiter() *pairSubmitLimiter {
	return &pairSubmitLimiter{
		hits:   make(map[string][]time.Time),
		max:    5,
		window: 5 * time.Minute,
	}
}

func (l *pairSubmitLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cut := now.Add(-l.window)
	keep := l.hits[ip][:0]
	for _, t := range l.hits[ip] {
		if t.After(cut) {
			keep = append(keep, t)
		}
	}
	if len(keep) >= l.max {
		l.hits[ip] = keep
		return false
	}
	keep = append(keep, now)
	l.hits[ip] = keep
	return true
}

// generatePairShortCode draws pairShortCodeLen characters from
// pairAlphabet using crypto/rand. Returns the printed form (no
// dashes; the TV can format it for display if desired).
func generatePairShortCode() (string, error) {
	out := make([]byte, pairShortCodeLen)
	buf := make([]byte, pairShortCodeLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	for i := 0; i < pairShortCodeLen; i++ {
		out[i] = pairAlphabet[int(buf[i])%len(pairAlphabet)]
	}
	return string(out), nil
}

// generatePairToken returns a 32-byte hex polling token. The TV holds
// this in component state for the duration of the pairing; the
// short-code path isn't sufficient on its own (a probe would be able
// to enumerate "did this short code complete yet" by guessing).
func generatePairToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// pairStartResponse mirrors the QC start shape: the TV needs a
// human-visible token (shortCode for the QR + url) plus an opaque
// polling token. expiresAt is informational; the TV's poll loop is
// the real deadline.
type pairStartResponse struct {
	ShortCode    string `json:"shortCode"`
	PairURL      string `json:"pairUrl"`
	PollingToken string `json:"pollingToken"`
	ExpiresAt    string `json:"expiresAt"`
}

// pairPollResponse is "pending" while the parent hasn't completed,
// "complete" once Jellyfin AuthenticateByName has succeeded (with
// the kid login payload embedded), or "expired" once the row is past
// TTL or has been cleaned up.
type pairPollResponse struct {
	Status string           `json:"status"`
	Kid    *kidAuthResponse `json:"kid,omitempty"`
}

// pairPublicURL returns the URL parents should land on. Reads from
// app_settings.public_url if set (production case behind a tunnel);
// falls back to the request's scheme + host (dev / LAN).
func (s *Server) pairPublicURL(ctx context.Context, r *http.Request) string {
	publicURL, _ := s.curation.AppSettingGet(ctx, "public_url")
	if publicURL != "" {
		return strings.TrimRight(publicURL, "/")
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// handleKidsPairStart mints a new pair session for the TV. The TV
// shows the resulting URL in a QR; the polling token is what it polls
// with. No auth required (it IS the auth flow).
func (s *Server) handleKidsPairStart(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.Header.Get(kidsDeviceIDHeader))

	// Best-effort cleanup so the table doesn't grow unbounded under
	// pathological clients. Fire-and-forget; an error here doesn't
	// fail the start.
	go func() {
		_, _ = s.curation.PrunePairSessions(context.Background(), time.Now())
	}()

	var (
		shortCode string
		err       error
	)
	// Retry on the (vanishingly small) chance of a short-code
	// collision against another live session. 31^6 ≈ 887M values vs
	// dozens of live sessions at most, so collisions are theoretical.
	for attempt := 0; attempt < 5; attempt++ {
		shortCode, err = generatePairShortCode()
		if err != nil {
			s.logger.Error().Err(err).Msg("pair start: short code")
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		_, err = s.curation.GetPairByShortCode(r.Context(), shortCode)
		if errors.Is(err, curation.ErrPairNotFound) {
			break
		}
		if err != nil {
			s.logger.Error().Err(err).Msg("pair start: lookup")
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		// collision: try again
		shortCode = ""
	}
	if shortCode == "" {
		http.Error(w, "could not allocate pair code", http.StatusInternalServerError)
		return
	}

	pollingToken, err := generatePairToken()
	if err != nil {
		s.logger.Error().Err(err).Msg("pair start: polling token")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	now := time.Now()
	expires := now.Add(pairTTL)
	if err := s.curation.CreatePairSession(r.Context(), curation.PairSession{
		ShortCode:    shortCode,
		PollingToken: pollingToken,
		CreatedAt:    now,
		ExpiresAt:    expires,
		DeviceID:     deviceID,
	}); err != nil {
		s.logger.Error().Err(err).Msg("pair start: persist")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	pairURL := s.pairPublicURL(r.Context(), r) + "/pair/" + shortCode

	s.logger.Info().
		Str("short_code", shortCode).
		Str("device_id", deviceID).
		Time("expires_at", expires).
		Msg("pair session started")

	writeJSON(w, http.StatusOK, pairStartResponse{
		ShortCode:    shortCode,
		PairURL:      pairURL,
		PollingToken: pollingToken,
		ExpiresAt:    expires.UTC().Format(time.RFC3339),
	})
}

// handleKidsPairPoll is the TV's status check. Returns pending /
// complete / expired. complete embeds the kid login payload (same
// shape as /auth/login) so the TV's session-mint code is shared.
func (s *Server) handleKidsPairPoll(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		http.Error(w, "token required", http.StatusBadRequest)
		return
	}
	sess, err := s.curation.GetPairByPollingToken(r.Context(), token)
	if err != nil {
		if errors.Is(err, curation.ErrPairNotFound) {
			writeJSON(w, http.StatusOK, pairPollResponse{Status: "expired"})
			return
		}
		s.logger.Error().Err(err).Msg("pair poll: lookup")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	now := time.Now()
	if sess.IsExpired(now) {
		writeJSON(w, http.StatusOK, pairPollResponse{Status: "expired"})
		return
	}
	switch sess.Status {
	case "pending":
		writeJSON(w, http.StatusOK, pairPollResponse{Status: "pending"})
		return
	case "expired":
		writeJSON(w, http.StatusOK, pairPollResponse{Status: "expired"})
		return
	case "complete":
		// Look up the kid record for the Jellyfin user the parent
		// signed in as. Mirrors handleKidsLogin's 403 gate exactly:
		// a valid Jellyfin user that isn't mapped to a kid record
		// can't seal a TV session.
		kid, err := s.curation.FindKidByJellyfinUser(r.Context(), sess.JellyfinUserID)
		if err != nil {
			if errors.Is(err, curation.ErrKidNotFound) {
				// The phone-side submit shouldn't have completed
				// without a kid mapping; if it did, the row is
				// effectively unusable. Surface as expired so the
				// TV restarts. Don't 403 here: the kid client's
				// poll loop treats 403 as "this user isn't a kid"
				// and would surface that as a permanent error;
				// "expired" lets them try again with a different
				// account.
				s.logger.Warn().
					Str("short_code", sess.ShortCode).
					Str("jellyfin_user_id", sess.JellyfinUserID).
					Msg("pair poll: completed user not mapped")
				writeJSON(w, http.StatusOK, pairPollResponse{Status: "expired"})
				return
			}
			s.logger.Error().Err(err).Msg("pair poll: kid lookup")
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, pairPollResponse{
			Status: "complete",
			Kid: &kidAuthResponse{
				Token:       sess.JellyfinToken,
				UserID:      sess.JellyfinUserID,
				UserName:    sess.JellyfinUserName,
				KidID:       kid.ID,
				KidName:     kid.Name,
				ProfileID:   kid.ProfileID,
				ProfileName: kid.ProfileName,
			},
		})
		return
	}
	// Unknown status (shouldn't happen given the CHECK constraint).
	writeJSON(w, http.StatusOK, pairPollResponse{Status: "expired"})
}

// handleKidsPairPage serves the phone-side HTML form. GET only.
// Server-rendered with inline CSS so it works without depending on
// either SPA bundle (the parent's phone might not have the kid SPA
// cached; this page lives outside both /player and /manage).
func (s *Server) handleKidsPairPage(w http.ResponseWriter, r *http.Request) {
	shortCode := strings.ToUpper(strings.TrimSpace(mux.Vars(r)["shortCode"]))
	if shortCode == "" {
		s.writePairHTML(w, http.StatusNotFound, pairPageData{
			Heading: "Invalid link",
			Message: "This pairing link is malformed. Get a fresh code on the TV.",
		})
		return
	}

	sess, err := s.curation.GetPairByShortCode(r.Context(), shortCode)
	if err != nil {
		if errors.Is(err, curation.ErrPairNotFound) {
			s.writePairHTML(w, http.StatusNotFound, pairPageData{
				Heading: "Code not found",
				Message: "Couldn't find that pairing code. Get a fresh one on the TV.",
			})
			return
		}
		s.logger.Error().Err(err).Msg("pair page: lookup")
		s.writePairHTML(w, http.StatusInternalServerError, pairPageData{
			Heading: "Server error",
			Message: "Something went wrong. Try refreshing in a moment.",
		})
		return
	}
	if sess.IsExpired(time.Now()) || sess.Status == "expired" {
		s.writePairHTML(w, http.StatusGone, pairPageData{
			Heading: "Code expired",
			Message: "This pairing code timed out. Get a fresh one on the TV.",
		})
		return
	}
	if sess.Status == "complete" {
		s.writePairHTML(w, http.StatusOK, pairPageData{
			ShortCode: shortCode,
			Heading:   "Already signed in",
			Message:   "This code has already been used. The TV should be on the home screen now.",
			Done:      true,
		})
		return
	}

	s.writePairHTML(w, http.StatusOK, pairPageData{
		ShortCode: shortCode,
		Heading:   "Sign in on TV",
		Message:   "Enter the kid's Jellyfin credentials. The TV will sign in automatically.",
		ShowForm:  true,
	})
}

// handleKidsPairSubmit is the phone form's POST target. Forwards
// credentials to Jellyfin's AuthenticateByName, gates on kid mapping,
// and on success marks the row complete so the TV's next /poll picks
// it up.
//
// Re-renders the same HTML page with an error message on failure so
// the parent can correct typos in place (vs. a JSON 4xx the form
// can't display).
func (s *Server) handleKidsPairSubmit(w http.ResponseWriter, r *http.Request) {
	shortCode := strings.ToUpper(strings.TrimSpace(mux.Vars(r)["shortCode"]))
	ip := clientIP(r)
	if !s.pairLimiter.allow(ip) {
		s.writePairHTML(w, http.StatusTooManyRequests, pairPageData{
			ShortCode: shortCode,
			Heading:   "Slow down",
			Message:   "Too many attempts from this device. Wait a few minutes and try again.",
			ShowForm:  true,
			Error:     "Rate limited.",
		})
		return
	}

	if err := r.ParseForm(); err != nil {
		s.writePairHTML(w, http.StatusBadRequest, pairPageData{
			ShortCode: shortCode,
			Heading:   "Sign in on TV",
			Message:   "Enter the kid's Jellyfin credentials. The TV will sign in automatically.",
			ShowForm:  true,
			Error:     "Couldn't read form. Try again.",
		})
		return
	}
	username := strings.TrimSpace(r.PostFormValue("username"))
	password := r.PostFormValue("password")
	if username == "" || password == "" {
		s.writePairHTML(w, http.StatusBadRequest, pairPageData{
			ShortCode: shortCode,
			Heading:   "Sign in on TV",
			Message:   "Enter the kid's Jellyfin credentials. The TV will sign in automatically.",
			ShowForm:  true,
			Username:  username,
			Error:     "Username and password are both required.",
		})
		return
	}

	sess, err := s.curation.GetPairByShortCode(r.Context(), shortCode)
	if err != nil {
		if errors.Is(err, curation.ErrPairNotFound) {
			s.writePairHTML(w, http.StatusNotFound, pairPageData{
				Heading: "Code not found",
				Message: "That pairing code doesn't exist. Get a fresh one on the TV.",
			})
			return
		}
		s.logger.Error().Err(err).Msg("pair submit: lookup")
		s.writePairHTML(w, http.StatusInternalServerError, pairPageData{
			ShortCode: shortCode,
			Heading:   "Server error",
			Message:   "Something went wrong. Try again in a moment.",
			ShowForm:  true,
			Username:  username,
		})
		return
	}
	if sess.IsExpired(time.Now()) || sess.Status == "expired" {
		s.writePairHTML(w, http.StatusGone, pairPageData{
			Heading: "Code expired",
			Message: "This pairing code timed out. Get a fresh one on the TV.",
		})
		return
	}
	if sess.Status == "complete" {
		s.writePairHTML(w, http.StatusOK, pairPageData{
			ShortCode: shortCode,
			Heading:   "Already signed in",
			Message:   "This code has already been used. The TV should be on the home screen now.",
			Done:      true,
		})
		return
	}

	// Forward to Jellyfin. Use the session's device id when present
	// so Jellyfin sees the same identity end-to-end (matches the
	// password-login codepath via kidsRequestContext).
	ctx := r.Context()
	if sess.DeviceID != "" {
		ctx = jellyfin.WithDeviceID(ctx, sess.DeviceID)
	}
	auth, err := s.jellyfin.AuthenticateByName(ctx, username, password)
	if err != nil {
		if jellyfin.IsUnauthorized(err) {
			s.writePairHTML(w, http.StatusUnauthorized, pairPageData{
				ShortCode: shortCode,
				Heading:   "Sign in on TV",
				Message:   "Enter the kid's Jellyfin credentials. The TV will sign in automatically.",
				ShowForm:  true,
				Username:  username,
				Error:     "Couldn't sign in. Check the username and password.",
			})
			return
		}
		s.logger.Error().Err(err).Msg("pair submit: jellyfin auth")
		s.writePairHTML(w, http.StatusBadGateway, pairPageData{
			ShortCode: shortCode,
			Heading:   "Sign in on TV",
			Message:   "Enter the kid's Jellyfin credentials. The TV will sign in automatically.",
			ShowForm:  true,
			Username:  username,
			Error:     "Couldn't reach Jellyfin. Try again.",
		})
		return
	}

	// Verify the Jellyfin user is mapped to a kid before completing.
	// Mirrors handleKidsLogin's 403 gate; better to fail here than
	// to mark the row complete and have the TV's poll bounce back.
	if _, err := s.curation.FindKidByJellyfinUser(r.Context(), auth.User.ID); err != nil {
		if errors.Is(err, curation.ErrKidNotFound) {
			s.writePairHTML(w, http.StatusForbidden, pairPageData{
				ShortCode: shortCode,
				Heading:   "Not a kid account",
				Message:   "This Jellyfin user isn't set up as a kid in Jellybean. Ask a parent to add them in the admin app first.",
				ShowForm:  true,
				Username:  username,
				Error:     "Account valid but not mapped to a kid.",
			})
			return
		}
		s.logger.Error().Err(err).Msg("pair submit: kid lookup")
		s.writePairHTML(w, http.StatusInternalServerError, pairPageData{
			ShortCode: shortCode,
			Heading:   "Server error",
			Message:   "Something went wrong looking up the kid record. Try again.",
			ShowForm:  true,
			Username:  username,
		})
		return
	}

	if err := s.curation.CompletePairSession(r.Context(), shortCode, auth.User.ID, auth.User.Name, auth.AccessToken); err != nil {
		if errors.Is(err, curation.ErrPairExpired) {
			s.writePairHTML(w, http.StatusGone, pairPageData{
				Heading: "Code expired",
				Message: "This pairing code timed out before we could finish. Get a fresh one on the TV.",
			})
			return
		}
		s.logger.Error().Err(err).Msg("pair submit: complete")
		s.writePairHTML(w, http.StatusInternalServerError, pairPageData{
			ShortCode: shortCode,
			Heading:   "Server error",
			Message:   "Something went wrong saving the sign-in. Try again.",
			ShowForm:  true,
			Username:  username,
		})
		return
	}

	s.logger.Info().
		Str("short_code", shortCode).
		Str("jellyfin_user_id", auth.User.ID).
		Str("jellyfin_user_name", auth.User.Name).
		Str("source_ip", ip).
		Msg("pair session completed")

	s.writePairHTML(w, http.StatusOK, pairPageData{
		ShortCode: shortCode,
		Heading:   "Signed in",
		Message:   fmt.Sprintf("Signed in as %s. You can close this window; the TV will pick it up automatically.", html.EscapeString(auth.User.Name)),
		Done:      true,
	})
}

// clientIP picks a best-guess source IP for the rate limiter.
// Behind a reverse proxy (Cloudflare tunnel + Synology) we'd want
// X-Forwarded-For; as a v1 we just trust the connection address.
// A future hardening pass can read CF-Connecting-IP / X-Real-IP
// once we settle on the production proxy chain.
func clientIP(r *http.Request) string {
	if h := r.Header.Get("CF-Connecting-IP"); h != "" {
		return h
	}
	if h := r.Header.Get("X-Real-IP"); h != "" {
		return h
	}
	if h := r.Header.Get("X-Forwarded-For"); h != "" {
		// Use first hop only.
		if i := strings.Index(h, ","); i >= 0 {
			return strings.TrimSpace(h[:i])
		}
		return strings.TrimSpace(h)
	}
	addr := r.RemoteAddr
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		return addr[:i]
	}
	return addr
}

// pairPageData feeds the inline HTML template. Only one form per
// page; success/expired views just hide the form.
type pairPageData struct {
	ShortCode string
	Heading   string
	Message   string
	Username  string // sticky on validation errors
	Error     string
	ShowForm  bool
	Done      bool
}

// writePairHTML renders the phone-side page. Inline template + inline
// CSS to keep it dependency-free.
func (s *Server) writePairHTML(w http.ResponseWriter, status int, d pairPageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	// hand-rolled rather than html/template so the file's blast
	// radius stays narrow (one external call writes one page); the
	// few interpolation sites use html.EscapeString explicitly.
	var b strings.Builder
	b.WriteString(pairHTMLPrefix)
	fmt.Fprintf(&b, "<h1>%s</h1>", html.EscapeString(d.Heading))
	if d.Message != "" {
		fmt.Fprintf(&b, "<p class=\"msg\">%s</p>", html.EscapeString(d.Message))
	}
	if d.Error != "" {
		fmt.Fprintf(&b, "<p class=\"err\">%s</p>", html.EscapeString(d.Error))
	}
	if d.Done {
		fmt.Fprintf(&b, "<p class=\"done\">You can close this window.</p>")
	}
	if d.ShowForm && d.ShortCode != "" {
		fmt.Fprintf(&b, `<form method="POST" action="/pair/%s/submit" autocomplete="on">`, html.EscapeString(d.ShortCode))
		fmt.Fprintf(&b, `<label>Username<input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required value="%s"></label>`, html.EscapeString(d.Username))
		fmt.Fprintf(&b, `<label>Password<input name="password" type="password" autocomplete="current-password" required></label>`)
		fmt.Fprintf(&b, `<button type="submit">Sign in</button>`)
		fmt.Fprintf(&b, `</form>`)
		fmt.Fprintf(&b, `<p class="footnote">Pairing code: <code>%s</code></p>`, html.EscapeString(d.ShortCode))
	}
	b.WriteString(pairHTMLSuffix)
	_, _ = w.Write([]byte(b.String()))
}

const pairHTMLPrefix = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Pair TV - Jellybean</title>
  <style>
    :root { color-scheme: dark; }
    html, body {
      margin: 0; padding: 0;
      min-height: 100%;
      background: #0c0d12;
      color: #e8e8ea;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    main {
      max-width: 28rem;
      margin: 0 auto;
      padding: 2rem 1.25rem;
    }
    h1 {
      font-size: 1.5rem;
      margin: 0 0 0.5rem;
    }
    p.msg { color: #c8c8d0; line-height: 1.45; margin: 0 0 1.25rem; }
    p.err {
      background: rgba(180, 30, 30, 0.45);
      color: #ffd0d0;
      padding: 0.6rem 0.85rem;
      border-radius: 8px;
      margin: 0 0 1rem;
    }
    p.done {
      background: rgba(40, 130, 80, 0.32);
      color: #c8f0d8;
      padding: 0.6rem 0.85rem;
      border-radius: 8px;
      margin: 0 0 1rem;
    }
    form { display: flex; flex-direction: column; gap: 0.85rem; }
    label {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      font-size: 0.85rem;
      color: #98989f;
    }
    input {
      background: #15161c;
      border: 1px solid #2a2b34;
      color: #e8e8ea;
      padding: 0.7rem 0.85rem;
      border-radius: 8px;
      font-size: 1rem;
      -webkit-appearance: none;
    }
    input:focus {
      outline: none;
      border-color: #8084ff;
      box-shadow: 0 0 0 3px rgba(128, 132, 255, 0.25);
    }
    button {
      background: #8084ff;
      color: #111;
      border: 0;
      border-radius: 8px;
      padding: 0.85rem 1rem;
      font-size: 1rem;
      font-weight: 600;
      margin-top: 0.4rem;
      cursor: pointer;
    }
    button:active { filter: brightness(0.95); }
    .footnote {
      margin-top: 1.5rem;
      font-size: 0.8rem;
      color: #76767e;
    }
    code {
      background: #1a1b22;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      letter-spacing: 0.06em;
    }
  </style>
</head>
<body>
<main>
`
const pairHTMLSuffix = `</main>
</body>
</html>
`

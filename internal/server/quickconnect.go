package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// Quick Connect proxy. The client (admin web or kid TV) calls
// /start to mint a pairing; the backend talks to Jellyfin's
// /QuickConnect/Initiate, stashes the Secret keyed by an opaque id,
// and hands {id, code, expiresAt} to the client. The client polls
// /poll?id=<id> every few seconds; the backend forwards each poll
// to Jellyfin's /QuickConnect/Connect, and once Jellyfin reports
// Authenticated=true, exchanges the Secret for a real AccessToken
// via /Users/AuthenticateWithQuickConnect. Admin path then mints a
// session cookie; kid path returns the bearer + profile.
//
// The Secret never leaves the backend - the kid TV only sees its
// own opaque id, so a compromised TV can't impersonate the user
// against Jellyfin directly.

const (
	// Pairing TTL matches Jellyfin's default. We expire our local
	// state at the same time so a /poll after Jellyfin's 404 also
	// 404s without an extra round trip.
	qcPairingTTL = 10 * time.Minute
	// How long we keep a successfully-authenticated pairing
	// reachable for a re-poll. The client should treat the first
	// successful /poll response as authoritative; this short
	// window just covers retries on flaky links.
	qcCompletedTTL = 30 * time.Second
)

// qcPairing is one in-flight Quick Connect handshake.
type qcPairing struct {
	id        string
	secret    string
	code      string
	deviceID  string
	expiresAt time.Time
	// cookieToken authenticates /poll requests. Returned to the
	// client as an HttpOnly Set-Cookie at /start; the client's
	// browser echoes it on /poll. Anyone who only knows `id`
	// (logs, accidental URL leaks) can't hijack the pairing -
	// they'd need both the id and the cookie token.
	cookieToken string
	// mu serializes the entire poll path (cache check + upstream
	// AuthenticateWithQuickConnect + result cache write). Holding
	// across the network call prevents the race where two
	// concurrent pollers both observe a nil authResult and both
	// call Jellyfin - the second hits "secret already consumed"
	// (Jellyfin returns 400 mapped to ErrUnauthorized) and the
	// caller would surface a stale-token redirect. With the lock
	// held, the second poller waits and serves from cache.
	mu sync.Mutex
	// authResult is cached after the first successful exchange so
	// duplicate /poll calls (browser refresh, flaky link) don't
	// re-hit Jellyfin. nil until authenticated.
	authResult *jellyfin.AuthResult
}

// qcStore is the in-memory pairing registry. Pairings are short-
// lived; a server restart drops them all (clients see "expired"
// on next poll, restart with a fresh /start). No persistence.
type qcStore struct {
	mu        sync.Mutex
	pairings  map[string]*qcPairing
	janitorOn bool
}

func newQCStore() *qcStore {
	return &qcStore{pairings: make(map[string]*qcPairing)}
}

func (s *qcStore) put(p *qcPairing) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pairings[p.id] = p
	if !s.janitorOn {
		s.janitorOn = true
		go s.janitor()
	}
}

func (s *qcStore) get(id string) *qcPairing {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pairings[id]
}

func (s *qcStore) drop(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pairings, id)
}

// janitor walks the map every minute and drops expired pairings.
// Started lazily on first put to keep cost zero in test setups
// that never use Quick Connect.
func (s *qcStore) janitor() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		s.mu.Lock()
		for id, p := range s.pairings {
			if now.After(p.expiresAt) {
				delete(s.pairings, id)
			}
		}
		empty := len(s.pairings) == 0
		if empty {
			s.janitorOn = false
		}
		s.mu.Unlock()
		if empty {
			return
		}
	}
}

// generatePairingID returns a 16-byte hex-encoded identifier the
// client polls with. Distinct from Jellyfin's Secret; the client
// never sees that.
func generatePairingID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// qcStartResponse is the payload returned from /quickconnect/start.
// The client shows the Code and polls with the id.
type qcStartResponse struct {
	ID        string    `json:"id"`
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// qcPollResponse covers the three states a poll can land in.
// Status is the discriminant: "pending" (still waiting for the
// user to enter the code), "authorized" (auth complete - the
// client should read the role-specific success fields below), or
// "expired" (the pairing is dead, start over).
type qcPollResponse struct {
	Status string `json:"status"`
	// Set on "authorized" (admin path): admin user info.
	User *adminUserResponse `json:"user,omitempty"`
	// Set on "authorized" (kid path): kid bearer token + profile
	// mapping. Same JSON shape as handleKidsLogin's 200 response so
	// the client's hydration logic doesn't branch on auth method.
	KidAuth *kidAuthResponse `json:"kid,omitempty"`
}

// adminUserResponse mirrors auth.userResponse but lives here so we
// don't need to export auth's private types. Kept narrow.
type adminUserResponse struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Admin bool   `json:"admin"`
}

// kidAuthResponse is the typed shape of the kid login success
// payload. handleKidsLogin emits the same shape (currently as an
// inline map[string]any); the kid client's auth.ts reads these
// fields by name. Defining it as a struct here makes the
// equivalence between password-login and Quick-Connect-login
// machine-checkable.
type kidAuthResponse struct {
	Token       string `json:"token"`
	UserID      string `json:"userId"`
	UserName    string `json:"userName"`
	KidID       int64  `json:"kidId"`
	KidName     string `json:"kidName"`
	ProfileID   int64  `json:"profileId"`
	ProfileName string `json:"profileName,omitempty"`
}

// qcCookieName is the HttpOnly cookie /start sets and /poll
// requires. Path is /api so the same cookie covers both the admin
// and kid endpoints; SameSite Lax is fine because both flows are
// driven from the same origin (the client polls the server it
// already loaded). Secure auto-flips with !IsDev() to match the
// session-cookie behavior.
const qcCookieName = "jellybean_qc"

// initiatePairing calls Jellyfin's /QuickConnect/Initiate, stashes
// the secret + code in the store keyed by a fresh id, and returns
// the start response (plus writes the auth cookie). Reused by
// admin + kid handlers.
//
// deviceID propagates to AuthenticateWithQuickConnect later via
// jellyfin.WithDeviceID(ctx, deviceID); Jellyfin requires the same
// id at both ends.
func (s *Server) initiatePairing(w http.ResponseWriter, r *http.Request, deviceID string) (*qcStartResponse, error) {
	ctx := r.Context()
	if deviceID != "" {
		ctx = jellyfin.WithDeviceID(ctx, deviceID)
	}
	res, err := s.jellyfin.InitiateQuickConnect(ctx)
	if err != nil {
		return nil, err
	}
	id, err := generatePairingID()
	if err != nil {
		return nil, err
	}
	cookieTok, err := generatePairingID()
	if err != nil {
		return nil, err
	}
	expires := time.Now().Add(qcPairingTTL)
	s.qc.put(&qcPairing{
		id:          id,
		secret:      res.Secret,
		code:        res.Code,
		deviceID:    deviceID,
		expiresAt:   expires,
		cookieToken: cookieTok,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     qcCookieName,
		Value:    cookieTok,
		Path:     "/api",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   !s.cfg.IsDev(),
		Expires:  expires,
		MaxAge:   int(qcPairingTTL.Seconds()),
	})
	return &qcStartResponse{
		ID:        id,
		Code:      res.Code,
		ExpiresAt: expires,
	}, nil
}

// resolvePollPairing returns the pairing for an /poll request. It
// requires both the `id` query param AND the qcCookieName cookie
// to match. Returns (nil, false) for any mismatch; the caller
// surfaces a 410 + status=expired so a probe can't tell "wrong
// cookie" apart from "TTL'd."
func (s *Server) resolvePollPairing(r *http.Request, id string) (*qcPairing, bool) {
	if id == "" {
		return nil, false
	}
	p := s.qc.get(id)
	if p == nil {
		return nil, false
	}
	c, err := r.Cookie(qcCookieName)
	if err != nil || c.Value == "" {
		return nil, false
	}
	if subtleEqual(c.Value, p.cookieToken) {
		return p, true
	}
	return nil, false
}

// subtleEqual is a constant-time comparator for the auth cookie.
// Any future timing-attack-aware tooling treats hex-encoded tokens
// as a fast equal-length compare; we still avoid early-return.
func subtleEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

// pollPairing forwards one client poll to Jellyfin and returns the
// resolved auth result when approval lands. Returns (nil, nil) on
// "still pending" so the caller can write a `status: pending`
// response without doing extra work. Returns (result, nil) on the
// first successful exchange (or a cached result on a duplicate
// poll). Returns (nil, errQCExpired) on TTL / Jellyfin 404 (which
// covers both "secret expired" and "secret already consumed").
//
// The pairing mutex is held across the upstream PollQuickConnect +
// AuthenticateWithQuickConnect calls so two concurrent /poll
// requests on the same id don't both invoke Jellyfin. The second
// one waits, reacquires the lock, sees the cached authResult, and
// returns it.
func (s *Server) pollPairing(r *http.Request, p *qcPairing) (*jellyfin.AuthResult, error) {
	// Acquire the pairing mutex BEFORE reading expiresAt -
	// pollPairing's success path mutates expiresAt under the lock,
	// so a bare read here would race with concurrent successful
	// pollers (race detector caught this).
	p.mu.Lock()
	defer p.mu.Unlock()
	if time.Now().After(p.expiresAt) {
		s.qc.drop(p.id)
		return nil, errQCExpired
	}
	if p.authResult != nil {
		return p.authResult, nil
	}
	ctx := r.Context()
	if p.deviceID != "" {
		ctx = jellyfin.WithDeviceID(ctx, p.deviceID)
	}
	got, err := s.jellyfin.PollQuickConnect(ctx, p.secret)
	if err != nil {
		if errors.Is(err, jellyfin.ErrNotFound) {
			s.qc.drop(p.id)
			return nil, errQCExpired
		}
		return nil, err
	}
	if !got.Authenticated {
		return nil, nil
	}
	auth, err := s.jellyfin.AuthenticateWithQuickConnect(ctx, p.secret)
	if err != nil {
		// 401 here typically means "secret already consumed by a
		// concurrent caller that beat us through" (we hold the
		// mutex so this should be impossible from our own code,
		// but Jellyfin can also revoke from its side). Treat it
		// the same as expiry so the client starts over cleanly.
		if errors.Is(err, jellyfin.ErrUnauthorized) {
			s.qc.drop(p.id)
			return nil, errQCExpired
		}
		return nil, err
	}
	p.authResult = auth
	p.expiresAt = time.Now().Add(qcCompletedTTL)
	return auth, nil
}

// errQCExpired is returned by pollPairing when the upstream pairing
// has TTL'd. The handlers translate it to a 410 + "expired" status
// so the client knows to start over.
var errQCExpired = errors.New("quick connect pairing expired")

// ------------------------------------------------------------------
// Shared: enabled probe
// ------------------------------------------------------------------

// handleQuickConnectEnabled lets the client probe whether the
// upstream Jellyfin admin has Quick Connect turned on. Returned as
// a tiny JSON object so the client doesn't need a special "this
// endpoint returns a bare bool" case.
func (s *Server) handleQuickConnectEnabled(w http.ResponseWriter, r *http.Request) {
	enabled, err := s.jellyfin.IsQuickConnectEnabled(r.Context())
	if err != nil {
		// Don't 5xx; the client should fall back to password login
		// gracefully when the probe fails for any reason.
		s.logger.Warn().Err(err).Msg("quick connect enabled probe")
		writeJSON(w, http.StatusOK, map[string]bool{"enabled": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": enabled})
}

// ------------------------------------------------------------------
// Admin Quick Connect handlers
// ------------------------------------------------------------------

// handleAdminQuickConnectStart mints a new pairing on behalf of an
// unauthenticated browser. The admin role check happens at
// /poll-success time (we can't know who's approving until they
// approve), not here.
func (s *Server) handleAdminQuickConnectStart(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.Header.Get("X-Jellybean-DeviceId"))
	if deviceID == "" {
		deviceID = "jellybean-admin"
	}
	out, err := s.initiatePairing(w, r, deviceID)
	if err != nil {
		s.logger.Error().Err(err).Msg("quick connect start (admin)")
		writeUpstreamError(w, err, "quick connect unavailable")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleAdminQuickConnectPoll resolves the pairing and on first
// approval mints a session cookie. Subsequent polls return the
// same user info while the cached pairing lives.
func (s *Server) handleAdminQuickConnectPoll(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	p, ok := s.resolvePollPairing(r, id)
	if !ok {
		// Indistinguishable for "wrong id", "wrong cookie", "TTL'd",
		// or "no cookie at all" - all surface as `expired` so a
		// probe can't enumerate live pairings.
		writeJSON(w, http.StatusGone, qcPollResponse{Status: "expired"})
		return
	}
	res, err := s.pollPairing(r, p)
	if err != nil {
		if errors.Is(err, errQCExpired) {
			writeJSON(w, http.StatusGone, qcPollResponse{Status: "expired"})
			return
		}
		s.logger.Error().Err(err).Msg("quick connect poll (admin)")
		writeUpstreamError(w, err, "quick connect unavailable")
		return
	}
	if res == nil {
		writeJSON(w, http.StatusOK, qcPollResponse{Status: "pending"})
		return
	}
	if !res.User.Policy.IsAdministrator {
		s.logger.Info().
			Str("user", res.User.Name).
			Msg("quick connect: non-admin denied")
		s.qc.drop(p.id)
		http.Error(w, "admin role required", http.StatusForbidden)
		return
	}
	// Mint our session. handlers exposes setCookie via the
	// Handlers type but it's package-private; replicate the cookie
	// shape inline rather than refactor.
	token, err := s.auth.Sessions.Create(r.Context(), res.User.ID, res.User.Name)
	if err != nil {
		s.logger.Error().Err(err).Msg("create session (quick connect)")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	setSessionCookie(w, token, !s.cfg.IsDev())
	writeJSON(w, http.StatusOK, qcPollResponse{
		Status: "authorized",
		User: &adminUserResponse{
			ID:    res.User.ID,
			Name:  res.User.Name,
			Admin: true,
		},
	})
}

// setSessionCookie mirrors auth.Handlers.setCookie. Duplicated so
// this file doesn't need to depend on the unexported helper. See
// internal/auth/handlers.go for the reference.
func setSessionCookie(w http.ResponseWriter, value string, secure bool) {
	c := &http.Cookie{
		Name:     "jellybean_session",
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	}
	c.Expires = time.Now().Add(auth.SessionDuration)
	c.MaxAge = int(auth.SessionDuration.Seconds())
	http.SetCookie(w, c)
}

// ------------------------------------------------------------------
// Kid Quick Connect handlers
// ------------------------------------------------------------------

// handleKidsQuickConnectStart is the TV-side mint. Same shape as
// admin start; the kid client passes its DeviceId header so
// Jellyfin sees one device identity across the whole login.
func (s *Server) handleKidsQuickConnectStart(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.Header.Get("X-Jellybean-DeviceId"))
	if deviceID == "" {
		deviceID = "jellybean-kids"
	}
	out, err := s.initiatePairing(w, r, deviceID)
	if err != nil {
		s.logger.Error().Err(err).Msg("quick connect start (kids)")
		writeUpstreamError(w, err, "quick connect unavailable")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleKidsQuickConnectPoll resolves the pairing and on approval
// validates the Jellyfin user is mapped to a kid record. Returns
// the bearer + profile mapping that mirrors handleKidsLogin's 200
// response so the client's session hydration is identical.
func (s *Server) handleKidsQuickConnectPoll(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	p, ok := s.resolvePollPairing(r, id)
	if !ok {
		writeJSON(w, http.StatusGone, qcPollResponse{Status: "expired"})
		return
	}
	res, err := s.pollPairing(r, p)
	if err != nil {
		if errors.Is(err, errQCExpired) {
			writeJSON(w, http.StatusGone, qcPollResponse{Status: "expired"})
			return
		}
		s.logger.Error().Err(err).Msg("quick connect poll (kids)")
		writeUpstreamError(w, err, "quick connect unavailable")
		return
	}
	if res == nil {
		writeJSON(w, http.StatusOK, qcPollResponse{Status: "pending"})
		return
	}
	// Validate the Jellyfin user is mapped to a kid record. Mirrors
	// the same gate handleKidsLogin enforces - a successful Jellyfin
	// auth doesn't grant TV access on its own.
	kid, err := s.curation.FindKidByJellyfinUser(r.Context(), res.User.ID)
	if err != nil {
		if errors.Is(err, curation.ErrKidNotFound) {
			s.qc.drop(p.id)
			http.Error(w, "user not mapped to a kid profile", http.StatusForbidden)
			return
		}
		s.logger.Error().Err(err).Msg("kid lookup (quick connect)")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Match handleKidsLogin's response shape exactly so the client's
	// existing hydration code (auth.ts setSession) doesn't branch.
	writeJSON(w, http.StatusOK, qcPollResponse{
		Status: "authorized",
		KidAuth: &kidAuthResponse{
			Token:       res.AccessToken,
			UserID:      res.User.ID,
			UserName:    res.User.Name,
			KidID:       kid.ID,
			KidName:     kid.Name,
			ProfileID:   kid.ProfileID,
			ProfileName: kid.ProfileName,
		},
	})
}

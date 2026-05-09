package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/config"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/db"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// qcFakeJellyfin is a minimal stand-in Jellyfin server that knows
// the four Quick Connect endpoints we proxy. State is mutable so a
// single test can walk pending -> approved without restarting the
// fake.
type qcFakeJellyfin struct {
	mu             sync.Mutex
	enabled        bool
	authenticated  bool
	approvedSecret string
	authUser       jellyfin.AuthUser
	accessToken    string
	srv            *httptest.Server
	// Stats: how many times each endpoint got hit. Helps catch
	// "client polled too aggressively" regressions.
	initiateHits int
	pollHits     int
	exchangeHits int
}

func newQCFakeJellyfin(t *testing.T) *qcFakeJellyfin {
	t.Helper()
	f := &qcFakeJellyfin{
		enabled:     true,
		accessToken: "qc-access-token",
		authUser: jellyfin.AuthUser{
			ID:   "kid-user-1",
			Name: "kid",
			Policy: jellyfin.UserPolicy{
				IsAdministrator: false,
			},
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/System/Info", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jellyfin.SystemInfo{Version: "10.10.7"})
	})
	mux.HandleFunc("/QuickConnect/Enabled", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		json.NewEncoder(w).Encode(f.enabled)
	})
	mux.HandleFunc("/QuickConnect/Initiate", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.initiateHits++
		f.mu.Unlock()
		json.NewEncoder(w).Encode(jellyfin.QuickConnectResult{
			Authenticated: false,
			Secret:        "test-secret-deadbeef",
			Code:          "654321",
			DeviceID:      "test-device",
			DateAdded:     time.Now(),
		})
	})
	mux.HandleFunc("/QuickConnect/Connect", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.pollHits++
		auth := f.authenticated
		f.mu.Unlock()
		secret := r.URL.Query().Get("secret")
		if secret == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(jellyfin.QuickConnectResult{
			Authenticated: auth,
			Secret:        secret,
			Code:          "654321",
		})
	})
	mux.HandleFunc("/Users/AuthenticateWithQuickConnect", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.exchangeHits++
		auth := f.authenticated
		user := f.authUser
		token := f.accessToken
		f.mu.Unlock()
		// Match Jellyfin's "missing token" branch when the secret
		// has not yet been authorized. The handler maps 400 to
		// ErrUnauthorized. We don't even need to read the body.
		if !auth {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(jellyfin.AuthResult{
			User:        user,
			AccessToken: token,
			ServerID:    "test-server",
		})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *qcFakeJellyfin) approve(user jellyfin.AuthUser) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.authenticated = true
	f.authUser = user
}

// qcServer wires up a Server backed by qcFakeJellyfin's URL. Mostly
// matches kidsTestServer but cuts out the kid-creation step so each
// test can decide whether to seed a kid (kid-path tests) or not
// (admin-path tests).
func qcServer(t *testing.T, fake *qcFakeJellyfin) *Server {
	t.Helper()
	conn, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	cfg := &config.Config{
		JellyfinURL:    fake.srv.URL,
		JellyfinAPIKey: "service-key",
		SessionSecret:  "test-secret",
		Env:            "dev",
	}
	srv := New(Options{
		Config:          cfg,
		Logger:          zerolog.Nop(),
		Jellyfin:        jellyfin.New(fake.srv.URL, cfg.JellyfinAPIKey),
		DB:              conn,
		JellyfinVersion: "10.10.7",
	})
	return srv
}

// rec is a tiny convenience for "do this request, return the recorder."
// Threads any cookies in the optional `cookies` slice onto the request
// so the QC poll path's per-pairing auth cookie can survive across
// helper calls. Tests grab Set-Cookie out of the /start response and
// pass it back on /poll.
func rec(srv *Server, method, target string, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	for _, c := range cookies {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	return w
}

// qcCookie returns the QC auth cookie from a /start response, or
// nil if the response didn't carry one. Tests use this to bind
// their /poll calls to the pairing they just minted.
func qcCookie(w *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == qcCookieName {
			return c
		}
	}
	return nil
}

// ---- /enabled probe ----------------------------------------------

func TestQuickConnectEnabledProbe(t *testing.T) {
	fake := newQCFakeJellyfin(t)
	srv := qcServer(t, fake)

	w := rec(srv, http.MethodGet, "/api/auth/quickconnect/enabled", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	var body struct{ Enabled bool }
	json.Unmarshal(w.Body.Bytes(), &body)
	if !body.Enabled {
		t.Errorf("expected enabled=true, got false")
	}

	// Flip the upstream off; the probe should reflect it.
	fake.mu.Lock()
	fake.enabled = false
	fake.mu.Unlock()
	w = rec(srv, http.MethodGet, "/api/auth/quickconnect/enabled", "")
	json.Unmarshal(w.Body.Bytes(), &body)
	if body.Enabled {
		t.Errorf("expected enabled=false after flip")
	}
}

// ---- admin path: start + poll-pending + approve + poll-authorized ---

// The admin happy path. We:
//   1. Start a pairing (assert id + code returned, secret hidden).
//   2. Poll while Jellyfin says pending.
//   3. Mark Jellyfin's authorize state.
//   4. Poll - now it flips to "authorized" and a session cookie
//      is set, returning the admin user payload.
func TestQuickConnectAdminFlow(t *testing.T) {
	fake := newQCFakeJellyfin(t)
	srv := qcServer(t, fake)

	// 1. Start.
	w := rec(srv, http.MethodPost, "/api/auth/quickconnect/start", "")
	if w.Code != http.StatusOK {
		t.Fatalf("start status %d body %s", w.Code, w.Body.String())
	}
	var start qcStartResponse
	json.Unmarshal(w.Body.Bytes(), &start)
	if start.ID == "" {
		t.Fatal("start: no id")
	}
	if start.Code != "654321" {
		t.Errorf("start: code = %q, want 654321", start.Code)
	}
	// Smoke-check the secret never appears in the response.
	if strings.Contains(w.Body.String(), "test-secret-deadbeef") {
		t.Fatalf("start leaked the upstream secret: %s", w.Body.String())
	}
	// /start sets the per-pairing auth cookie; /poll must carry it.
	authCookie := qcCookie(w)
	if authCookie == nil {
		t.Fatal("start: no jellybean_qc cookie set")
	}

	// 2. Pending poll.
	w = rec(srv, http.MethodGet,
		"/api/auth/quickconnect/poll?id="+start.ID, "", authCookie)
	if w.Code != http.StatusOK {
		t.Fatalf("pending poll status %d", w.Code)
	}
	var poll qcPollResponse
	json.Unmarshal(w.Body.Bytes(), &poll)
	if poll.Status != "pending" {
		t.Errorf("pending poll status = %q, want pending", poll.Status)
	}

	// 3. Approve: simulate the user entering the code on another
	// Jellyfin client. Mark them as admin so the post-exchange
	// gate passes.
	fake.approve(jellyfin.AuthUser{
		ID:     "admin-1",
		Name:   "fisher",
		Policy: jellyfin.UserPolicy{IsAdministrator: true},
	})

	// 4. Authorized poll. Cookie should be set; user payload
	// returned.
	w = rec(srv, http.MethodGet,
		"/api/auth/quickconnect/poll?id="+start.ID, "", authCookie)
	if w.Code != http.StatusOK {
		t.Fatalf("authorized poll status %d body %s", w.Code, w.Body.String())
	}
	json.Unmarshal(w.Body.Bytes(), &poll)
	if poll.Status != "authorized" {
		t.Errorf("authorized poll status = %q, want authorized", poll.Status)
	}
	if poll.User == nil || poll.User.ID != "admin-1" {
		t.Errorf("authorized poll user = %+v, want id=admin-1", poll.User)
	}
	cookies := w.Result().Cookies()
	var hasCookie bool
	for _, c := range cookies {
		if c.Name == "jellybean_session" && c.Value != "" {
			hasCookie = true
		}
	}
	if !hasCookie {
		t.Error("authorized poll didn't set the session cookie")
	}
}

// Non-admin Jellyfin user that gets QC-approved should be rejected
// at the admin path (matches password-login's 403).
func TestQuickConnectAdminNonAdminDenied(t *testing.T) {
	fake := newQCFakeJellyfin(t)
	srv := qcServer(t, fake)

	w := rec(srv, http.MethodPost, "/api/auth/quickconnect/start", "")
	var start qcStartResponse
	json.Unmarshal(w.Body.Bytes(), &start)
	authCookie := qcCookie(w)

	// Approve as a non-admin.
	fake.approve(jellyfin.AuthUser{
		ID:     "kid-user-1",
		Name:   "kid",
		Policy: jellyfin.UserPolicy{IsAdministrator: false},
	})
	w = rec(srv, http.MethodGet,
		"/api/auth/quickconnect/poll?id="+start.ID, "", authCookie)
	if w.Code != http.StatusForbidden {
		t.Fatalf("non-admin poll status %d, want 403", w.Code)
	}
}

// Polling an unknown id 410s with status=expired.
func TestQuickConnectPollUnknownID(t *testing.T) {
	fake := newQCFakeJellyfin(t)
	srv := qcServer(t, fake)

	w := rec(srv, http.MethodGet,
		"/api/auth/quickconnect/poll?id=does-not-exist", "")
	if w.Code != http.StatusGone {
		t.Errorf("unknown id status = %d, want 410", w.Code)
	}
	var poll qcPollResponse
	json.Unmarshal(w.Body.Bytes(), &poll)
	if poll.Status != "expired" {
		t.Errorf("unknown id status = %q, want expired", poll.Status)
	}
}

// Polling a real id without the auth cookie must 410 just like an
// unknown id - we don't want a probe to be able to enumerate live
// pairings by treating "wrong cookie" differently. Same shape as
// "TTL'd" so an attacker who guesses an id can't tell live from
// expired apart.
func TestQuickConnectPollWithoutCookieRejected(t *testing.T) {
	fake := newQCFakeJellyfin(t)
	srv := qcServer(t, fake)

	w := rec(srv, http.MethodPost, "/api/auth/quickconnect/start", "")
	var start qcStartResponse
	json.Unmarshal(w.Body.Bytes(), &start)
	// Deliberately don't pass the cookie.
	w = rec(srv, http.MethodGet,
		"/api/auth/quickconnect/poll?id="+start.ID, "")
	if w.Code != http.StatusGone {
		t.Errorf("no-cookie poll status = %d, want 410", w.Code)
	}
}

// Polling a real id with a wrong cookie (e.g. attacker who saw the
// id in a log but never had the cookie) must also 410, not 200.
func TestQuickConnectPollWrongCookieRejected(t *testing.T) {
	fake := newQCFakeJellyfin(t)
	srv := qcServer(t, fake)

	w := rec(srv, http.MethodPost, "/api/auth/quickconnect/start", "")
	var start qcStartResponse
	json.Unmarshal(w.Body.Bytes(), &start)

	wrong := &http.Cookie{
		Name:  qcCookieName,
		Value: "00000000000000000000000000000000",
	}
	w = rec(srv, http.MethodGet,
		"/api/auth/quickconnect/poll?id="+start.ID, "", wrong)
	if w.Code != http.StatusGone {
		t.Errorf("wrong-cookie poll status = %d, want 410", w.Code)
	}
}

// ---- kid path: full flow with profile + kid mapping --------------

func TestQuickConnectKidFlow(t *testing.T) {
	fake := newQCFakeJellyfin(t)
	srv := qcServer(t, fake)

	// Seed a kid record for the user the fake will approve.
	store := curation.NewStore(srv.db)
	var profileID int64
	if err := srv.db.QueryRow(`SELECT id FROM profiles WHERE name = 'Default'`).Scan(&profileID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateKid(t.Context(), curation.CreateKidParams{
		Name:           "test-kid",
		ProfileID:      profileID,
		JellyfinUserID: "kid-user-1",
	}); err != nil {
		t.Fatal(err)
	}

	// 1. Start.
	w := rec(srv, http.MethodPost, "/api/kids/auth/quickconnect/start", "")
	if w.Code != http.StatusOK {
		t.Fatalf("kid start status %d body %s", w.Code, w.Body.String())
	}
	var start qcStartResponse
	json.Unmarshal(w.Body.Bytes(), &start)
	authCookie := qcCookie(w)

	// 2. Approve as the seeded kid user.
	fake.approve(jellyfin.AuthUser{
		ID:     "kid-user-1",
		Name:   "kid",
		Policy: jellyfin.UserPolicy{IsAdministrator: false},
	})
	w = rec(srv, http.MethodGet,
		"/api/kids/auth/quickconnect/poll?id="+start.ID, "", authCookie)
	if w.Code != http.StatusOK {
		t.Fatalf("kid poll status %d body %s", w.Code, w.Body.String())
	}
	var poll qcPollResponse
	json.Unmarshal(w.Body.Bytes(), &poll)
	if poll.Status != "authorized" {
		t.Errorf("kid poll status = %q, want authorized", poll.Status)
	}
	// The kid path must return the bearer + profile mapping the
	// kid client expects (same shape as /api/kids/auth/login).
	if poll.KidAuth == nil {
		t.Fatal("kid poll: missing kid payload")
	}
	if poll.KidAuth.Token != "qc-access-token" {
		t.Errorf("kid token = %q, want qc-access-token", poll.KidAuth.Token)
	}
	if poll.KidAuth.UserID != "kid-user-1" {
		t.Errorf("kid userId = %q, want kid-user-1", poll.KidAuth.UserID)
	}
}

// Approved Jellyfin user that has no kid mapping is denied at the
// kid path (matches password-login's 403).
func TestQuickConnectKidNotMappedDenied(t *testing.T) {
	fake := newQCFakeJellyfin(t)
	srv := qcServer(t, fake)
	// No kid seeded - any approved user fails the mapping lookup.

	w := rec(srv, http.MethodPost, "/api/kids/auth/quickconnect/start", "")
	var start qcStartResponse
	json.Unmarshal(w.Body.Bytes(), &start)
	authCookie := qcCookie(w)

	fake.approve(jellyfin.AuthUser{
		ID:     "unknown-user",
		Name:   "stranger",
		Policy: jellyfin.UserPolicy{IsAdministrator: false},
	})
	w = rec(srv, http.MethodGet,
		"/api/kids/auth/quickconnect/poll?id="+start.ID, "", authCookie)
	if w.Code != http.StatusForbidden {
		t.Errorf("unmapped kid status %d, want 403", w.Code)
	}
}

// Re-polling after a successful authorize must return the same
// payload without re-hitting Jellyfin's AuthenticateWithQuickConnect.
// Tests the cache (sequential), not the concurrent race - the
// concurrent race is prevented by holding p.mu across the upstream
// call and is exercised by TestQuickConnectConcurrentPollSerialized
// below.
func TestQuickConnectIdempotentReply(t *testing.T) {
	fake := newQCFakeJellyfin(t)
	srv := qcServer(t, fake)

	w := rec(srv, http.MethodPost, "/api/auth/quickconnect/start", "")
	var start qcStartResponse
	json.Unmarshal(w.Body.Bytes(), &start)
	authCookie := qcCookie(w)

	fake.approve(jellyfin.AuthUser{
		ID:     "admin-1",
		Name:   "fisher",
		Policy: jellyfin.UserPolicy{IsAdministrator: true},
	})

	// First authorized poll - performs the exchange.
	rec(srv, http.MethodGet,
		"/api/auth/quickconnect/poll?id="+start.ID, "", authCookie)
	firstHits := fake.exchangeHits

	// Second poll - cached path; no new exchange.
	w = rec(srv, http.MethodGet,
		"/api/auth/quickconnect/poll?id="+start.ID, "", authCookie)
	if w.Code != http.StatusOK {
		t.Fatalf("second poll status %d", w.Code)
	}
	if fake.exchangeHits != firstHits {
		t.Errorf("second poll re-hit AuthenticateWithQuickConnect (%d -> %d); should serve from cache",
			firstHits, fake.exchangeHits)
	}
}

// Two concurrent /poll calls on the same authorized pairing must
// not both call AuthenticateWithQuickConnect upstream. Catches the
// race fix that holds p.mu across the upstream call: without the
// lock, both goroutines see authResult==nil, both invoke Jellyfin,
// and the second hits "secret already consumed" (mapped to
// ErrUnauthorized). With the lock, the second waits, reacquires,
// sees the cached result, and returns it.
func TestQuickConnectConcurrentPollSerialized(t *testing.T) {
	fake := newQCFakeJellyfin(t)
	srv := qcServer(t, fake)

	w := rec(srv, http.MethodPost, "/api/auth/quickconnect/start", "")
	var start qcStartResponse
	json.Unmarshal(w.Body.Bytes(), &start)
	authCookie := qcCookie(w)
	fake.approve(jellyfin.AuthUser{
		ID:     "admin-1",
		Name:   "fisher",
		Policy: jellyfin.UserPolicy{IsAdministrator: true},
	})

	// Fire N concurrent polls. Both should resolve to the
	// authorized payload but only one upstream exchange should
	// hit the fake.
	const N = 8
	var wg sync.WaitGroup
	codes := make([]int, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			rr := rec(srv, http.MethodGet,
				"/api/auth/quickconnect/poll?id="+start.ID, "", authCookie)
			codes[idx] = rr.Code
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusOK {
			t.Errorf("poll %d: status = %d, want 200", i, c)
		}
	}
	// Read the counter under the fake's mutex; the race detector
	// flags a bare read here because the goroutines updated it
	// from other m.Lock'd writes.
	fake.mu.Lock()
	hits := fake.exchangeHits
	fake.mu.Unlock()
	if hits != 1 {
		t.Errorf("AuthenticateWithQuickConnect hit %d times; want 1 (concurrent pollers should serialize on the pairing mutex)",
			hits)
	}
}

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/config"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/db"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// pairFakeJellyfin is a tiny stub that answers AuthenticateByName
// based on a credential map. Used to drive the phone-side submit
// step without spinning up the full library mock.
type pairFakeJellyfin struct {
	mu          sync.Mutex
	credentials map[string]pairFakeCred // username -> creds
	srv         *httptest.Server
	authHits    int
}

type pairFakeCred struct {
	password string
	userID   string
	userName string
	token    string
}

func newPairFakeJellyfin(t *testing.T) *pairFakeJellyfin {
	t.Helper()
	f := &pairFakeJellyfin{
		credentials: map[string]pairFakeCred{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/System/Info", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jellyfin.SystemInfo{Version: "10.10.7"})
	})
	mux.HandleFunc("/Users/AuthenticateByName", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.authHits++
		f.mu.Unlock()
		var body struct {
			Username string `json:"Username"`
			Pw       string `json:"Pw"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		c, ok := f.credentials[body.Username]
		f.mu.Unlock()
		if !ok || c.password != body.Pw {
			// Match Jellyfin's "bad creds" 400 path so the
			// client maps it to ErrUnauthorized.
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte("Error processing request."))
			return
		}
		json.NewEncoder(w).Encode(jellyfin.AuthResult{
			User:        jellyfin.AuthUser{ID: c.userID, Name: c.userName},
			AccessToken: c.token,
			ServerID:    "test-server",
		})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *pairFakeJellyfin) addUser(username, password, userID, userName, token string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.credentials[username] = pairFakeCred{
		password: password,
		userID:   userID,
		userName: userName,
		token:    token,
	}
}

// pairTestServer wires a Server backed by pairFakeJellyfin. Seeds the
// Default profile with one kid for the userID the caller decides to
// approve, so the FindKidByJellyfinUser gate passes.
func pairTestServer(t *testing.T, fake *pairFakeJellyfin, kidUserID string) (*Server, int64) {
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
	store := curation.NewStore(srv.db)
	var profileID int64
	if err := srv.db.QueryRow(`SELECT id FROM profiles WHERE name = 'Default'`).Scan(&profileID); err != nil {
		t.Fatal(err)
	}
	if kidUserID != "" {
		if _, err := store.CreateKid(t.Context(), curation.CreateKidParams{
			Name:           "test-kid",
			ProfileID:      profileID,
			JellyfinUserID: kidUserID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	return srv, profileID
}

// pairFormSubmit issues the phone-side POST. Returns the recorder so
// tests can inspect status + body for the rendered HTML.
func pairFormSubmit(srv *Server, shortCode, username, password string) *httptest.ResponseRecorder {
	form := url.Values{}
	form.Set("username", username)
	form.Set("password", password)
	r := httptest.NewRequest(http.MethodPost, "/pair/"+shortCode+"/submit",
		strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.RemoteAddr = "127.0.0.1:9000"
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	return w
}

// TestKidsPairHappyPath drives start -> phone-submit -> poll. The kid
// path must surface the same login payload as /api/kids/auth/login so
// the TV's session-mint code is shared.
func TestKidsPairHappyPath(t *testing.T) {
	fake := newPairFakeJellyfin(t)
	fake.addUser("alice", "pw123", "kid-user-1", "alice", "kid-token-xyz")
	srv, _ := pairTestServer(t, fake, "kid-user-1")

	// 1. TV start
	w := rec(srv, http.MethodPost, "/api/kids/auth/pair/start", "")
	if w.Code != http.StatusOK {
		t.Fatalf("pair start status %d body %s", w.Code, w.Body.String())
	}
	var start pairStartResponse
	if err := json.Unmarshal(w.Body.Bytes(), &start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	if len(start.ShortCode) != pairShortCodeLen {
		t.Errorf("short code len = %d, want %d", len(start.ShortCode), pairShortCodeLen)
	}
	if start.PollingToken == "" {
		t.Error("missing polling token")
	}
	if !strings.HasSuffix(start.PairURL, "/pair/"+start.ShortCode) {
		t.Errorf("pair url = %q, expected suffix /pair/%s", start.PairURL, start.ShortCode)
	}

	// 2. Phone GET renders the form.
	w = rec(srv, http.MethodGet, "/pair/"+start.ShortCode, "")
	if w.Code != http.StatusOK {
		t.Fatalf("pair page status %d body %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `name="username"`) {
		t.Error("pair page missing username field")
	}

	// 3. TV polls before submit -> pending
	w = rec(srv, http.MethodGet, "/api/kids/auth/pair/poll?token="+start.PollingToken, "")
	if w.Code != http.StatusOK {
		t.Fatalf("pending poll status %d body %s", w.Code, w.Body.String())
	}
	var poll pairPollResponse
	json.Unmarshal(w.Body.Bytes(), &poll)
	if poll.Status != "pending" {
		t.Errorf("first poll status = %q, want pending", poll.Status)
	}

	// 4. Phone submits creds.
	w = pairFormSubmit(srv, start.ShortCode, "alice", "pw123")
	if w.Code != http.StatusOK {
		t.Fatalf("pair submit status %d body %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Signed in") {
		t.Errorf("pair submit body missing success marker: %s", w.Body.String())
	}

	// 5. TV polls after submit -> complete with kid payload.
	w = rec(srv, http.MethodGet, "/api/kids/auth/pair/poll?token="+start.PollingToken, "")
	if w.Code != http.StatusOK {
		t.Fatalf("post-submit poll status %d body %s", w.Code, w.Body.String())
	}
	json.Unmarshal(w.Body.Bytes(), &poll)
	if poll.Status != "complete" {
		t.Errorf("post-submit poll status = %q, want complete", poll.Status)
	}
	if poll.Kid == nil {
		t.Fatal("post-submit poll missing kid payload")
	}
	if poll.Kid.Token != "kid-token-xyz" {
		t.Errorf("kid token = %q, want kid-token-xyz", poll.Kid.Token)
	}
	if poll.Kid.UserID != "kid-user-1" {
		t.Errorf("kid userId = %q, want kid-user-1", poll.Kid.UserID)
	}
	if poll.Kid.KidName != "test-kid" {
		t.Errorf("kid name = %q, want test-kid", poll.Kid.KidName)
	}
}

// TestKidsPairBadCredsKeepsPending asserts a wrong-password submit
// doesn't mark the row complete; the TV's poll keeps returning
// pending so the parent can correct in place.
func TestKidsPairBadCredsKeepsPending(t *testing.T) {
	fake := newPairFakeJellyfin(t)
	fake.addUser("alice", "pw123", "kid-user-1", "alice", "kid-token-xyz")
	srv, _ := pairTestServer(t, fake, "kid-user-1")

	w := rec(srv, http.MethodPost, "/api/kids/auth/pair/start", "")
	var start pairStartResponse
	json.Unmarshal(w.Body.Bytes(), &start)

	// Wrong password.
	w = pairFormSubmit(srv, start.ShortCode, "alice", "wrong")
	if w.Code != http.StatusUnauthorized {
		t.Errorf("bad-creds submit status %d, want 401", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Couldn&#39;t sign in") {
		t.Errorf("bad-creds body missing error: %s", w.Body.String())
	}

	// Poll should still be pending.
	w = rec(srv, http.MethodGet, "/api/kids/auth/pair/poll?token="+start.PollingToken, "")
	var poll pairPollResponse
	json.Unmarshal(w.Body.Bytes(), &poll)
	if poll.Status != "pending" {
		t.Errorf("after bad creds poll status = %q, want pending", poll.Status)
	}
}

// TestKidsPairUnknownTokenExpired asserts the poll returns "expired"
// (not 4xx) for a polling token that's never been minted. The TV's
// poll loop treats expired as "show retry button"; 4xx would surface
// as a generic error.
func TestKidsPairUnknownTokenExpired(t *testing.T) {
	fake := newPairFakeJellyfin(t)
	srv, _ := pairTestServer(t, fake, "")

	w := rec(srv, http.MethodGet, "/api/kids/auth/pair/poll?token=deadbeef", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", w.Code)
	}
	var poll pairPollResponse
	json.Unmarshal(w.Body.Bytes(), &poll)
	if poll.Status != "expired" {
		t.Errorf("poll status = %q, want expired", poll.Status)
	}
}

// TestKidsPairUserNotMappedToKid asserts a Jellyfin user that's
// validly authenticated but isn't mapped to a kid record gets a 403
// from the phone-side submit (mirrors handleKidsLogin's gate).
func TestKidsPairUserNotMappedToKid(t *testing.T) {
	fake := newPairFakeJellyfin(t)
	// Register the credential but don't create a kid for this user.
	fake.addUser("stranger", "pw", "stranger-id", "stranger", "stranger-token")
	srv, _ := pairTestServer(t, fake, "")

	w := rec(srv, http.MethodPost, "/api/kids/auth/pair/start", "")
	var start pairStartResponse
	json.Unmarshal(w.Body.Bytes(), &start)

	w = pairFormSubmit(srv, start.ShortCode, "stranger", "pw")
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Not a kid account") {
		t.Errorf("body missing not-a-kid marker: %s", w.Body.String())
	}
}

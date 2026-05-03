// Package server wires the HTTP routes for Jellybean.
//
// The router is owned here and exposed as an http.Handler. The cmd/jellybean
// entrypoint takes care of process lifecycle (signals, listener, graceful
// shutdown).
package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/config"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

type Server struct {
	cfg      *config.Config
	logger   zerolog.Logger
	jellyfin *jellyfin.Client
	db       *sql.DB
	auth     *auth.Handlers
	router   *mux.Router

	jellyfinVersion string
}

func New(cfg *config.Config, logger zerolog.Logger, jf *jellyfin.Client, db *sql.DB, jellyfinVersion string) *Server {
	sessions := auth.NewSessionStore(db, cfg.SessionSecret)
	rl := auth.NewRateLimiter(5, 5*time.Minute)
	authH := &auth.Handlers{
		Sessions:      sessions,
		Jellyfin:      jf,
		Logger:        logger,
		RateLimit:     rl,
		SecureCookies: !cfg.IsDev(),
	}

	s := &Server{
		cfg:             cfg,
		logger:          logger,
		jellyfin:        jf,
		db:              db,
		auth:            authH,
		router:          mux.NewRouter(),
		jellyfinVersion: jellyfinVersion,
	}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler {
	return s.router
}

func (s *Server) routes() {
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/health", s.handleHealth).Methods(http.MethodGet)

	authR := api.PathPrefix("/auth").Subrouter()
	authR.HandleFunc("/login", s.auth.Login).Methods(http.MethodPost)
	authR.HandleFunc("/logout", s.auth.Logout).Methods(http.MethodPost)
	// /api/auth/me is the "am I logged in" probe; gate it with the auth middleware.
	authR.Handle("/me", s.auth.Middleware(http.HandlerFunc(s.auth.Me))).Methods(http.MethodGet)

	// Future authenticated routes (curation API in M2) hang off /api/admin and
	// share the auth middleware via a subrouter.
	admin := api.PathPrefix("/admin").Subrouter()
	admin.Use(s.auth.Middleware)
	_ = admin // M2 will mount handlers here
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":           "ok",
		"jellyfin_version": s.jellyfinVersion,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Package server wires the HTTP routes for Jellybean.
//
// The router is owned here and exposed as an http.Handler. The cmd/jellybean
// entrypoint takes care of process lifecycle (signals, listener, graceful
// shutdown).
package server

import (
	"database/sql"
	"encoding/json"
	"io/fs"
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
	adminAssets     fs.FS
	kidsAssets      fs.FS
}

type Options struct {
	Config          *config.Config
	Logger          zerolog.Logger
	Jellyfin        *jellyfin.Client
	DB              *sql.DB
	JellyfinVersion string
	AdminAssets     fs.FS // root containing web/admin/dist
	KidsAssets      fs.FS // root containing web/kids/dist
}

func New(opts Options) *Server {
	sessions := auth.NewSessionStore(opts.DB, opts.Config.SessionSecret)
	rl := auth.NewRateLimiter(5, 5*time.Minute)
	authH := &auth.Handlers{
		Sessions:      sessions,
		Jellyfin:      opts.Jellyfin,
		Logger:        opts.Logger,
		RateLimit:     rl,
		SecureCookies: !opts.Config.IsDev(),
	}

	s := &Server{
		cfg:             opts.Config,
		logger:          opts.Logger,
		jellyfin:        opts.Jellyfin,
		db:              opts.DB,
		auth:            authH,
		router:          mux.NewRouter(),
		jellyfinVersion: opts.JellyfinVersion,
		adminAssets:     opts.AdminAssets,
		kidsAssets:      opts.KidsAssets,
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
	authR.Handle("/me", s.auth.Middleware(http.HandlerFunc(s.auth.Me))).Methods(http.MethodGet)

	admin := api.PathPrefix("/admin").Subrouter()
	admin.Use(s.auth.Middleware)
	admin.HandleFunc("/items", s.handleAdminItems).Methods(http.MethodGet)
	admin.HandleFunc("/items/{id}/stream", s.handleAdminStream).Methods(http.MethodGet)

	// Static SPAs. Order matters: /kids prefix wins over /, so the more
	// specific one is registered first.
	if s.kidsAssets != nil {
		kids, err := newSPA(s.kidsAssets, "web/kids/dist")
		if err == nil {
			s.router.PathPrefix("/kids").Handler(http.StripPrefix("/kids", kids))
		} else {
			s.logger.Warn().Err(err).Msg("kids SPA disabled")
		}
	}
	if s.adminAssets != nil {
		admin, err := newSPA(s.adminAssets, "web/admin/dist")
		if err == nil {
			s.router.PathPrefix("/").Handler(admin)
		} else {
			s.logger.Warn().Err(err).Msg("admin SPA disabled")
		}
	}
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

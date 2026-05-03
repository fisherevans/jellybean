// Package server wires the HTTP routes for Jellybean.
//
// The router is owned here and exposed as an http.Handler. The cmd/jellybean
// entrypoint takes care of process lifecycle (signals, listener, graceful
// shutdown).
package server

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/config"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

type Server struct {
	cfg      *config.Config
	logger   zerolog.Logger
	jellyfin *jellyfin.Client
	router   *mux.Router

	jellyfinVersion string
}

func New(cfg *config.Config, logger zerolog.Logger, jf *jellyfin.Client, jellyfinVersion string) *Server {
	s := &Server{
		cfg:             cfg,
		logger:          logger,
		jellyfin:        jf,
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

// Package server wires the HTTP routes for Jellybean.
//
// The router is owned here and exposed as an http.Handler. The cmd/jellybean
// entrypoint takes care of process lifecycle (signals, listener, graceful
// shutdown).
package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"github.com/rs/zerolog"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/config"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

type Server struct {
	cfg      *config.Config
	logger   zerolog.Logger
	jellyfin *jellyfin.Client
	db       *sql.DB
	auth     *auth.Handlers
	curation *curation.Store
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
	curStore := curation.NewStore(opts.DB)
	authH := &auth.Handlers{
		Sessions:      sessions,
		Jellyfin:      opts.Jellyfin,
		Logger:        opts.Logger,
		RateLimit:     rl,
		SecureCookies: !opts.Config.IsDev(),
		Bearer:        &bearerAdapter{store: curStore},
	}

	s := &Server{
		cfg:             opts.Config,
		logger:          opts.Logger,
		jellyfin:        opts.Jellyfin,
		db:              opts.DB,
		auth:            authH,
		curation:        curStore,
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
	admin.HandleFunc("/items/{id}/tags", s.handleAdminGetItemTags).Methods(http.MethodGet)
	admin.HandleFunc("/items/{id}/tags", s.handleAdminSetItemTags).Methods(http.MethodPut)
	admin.HandleFunc("/items/{id}/image", s.handleAdminImage).Methods(http.MethodGet)
	admin.HandleFunc("/items/{id}/stream", s.handleAdminStream).Methods(http.MethodGet)
	admin.HandleFunc("/items/{id}/state", s.handleAdminSetState).Methods(http.MethodPost)
	admin.HandleFunc("/items/state/bulk", s.handleAdminBulkState).Methods(http.MethodPost)
	admin.HandleFunc("/categorizations/recent", s.handleAdminRecentActivity).Methods(http.MethodGet)
	admin.HandleFunc("/maintenance/reconcile", s.handleAdminReconcile).Methods(http.MethodPost)
	admin.HandleFunc("/profiles", s.handleListProfiles).Methods(http.MethodGet)
	admin.HandleFunc("/profiles", s.handleCreateProfile).Methods(http.MethodPost)
	admin.HandleFunc("/profiles/{id}", s.handleUpdateProfile).Methods(http.MethodPatch)
	admin.HandleFunc("/profiles/{id}", s.handleDeleteProfile).Methods(http.MethodDelete)
	admin.HandleFunc("/kids", s.handleListKids).Methods(http.MethodGet)
	admin.HandleFunc("/kids", s.handleCreateKid).Methods(http.MethodPost)
	admin.HandleFunc("/kids/{id}", s.handleUpdateKid).Methods(http.MethodPatch)
	admin.HandleFunc("/kids/{id}", s.handleDeleteKid).Methods(http.MethodDelete)
	admin.HandleFunc("/jellyfin/users", s.handleListJellyfinUsers).Methods(http.MethodGet)
	admin.HandleFunc("/tags", s.handleListTags).Methods(http.MethodGet)
	admin.HandleFunc("/tags", s.handleCreateTag).Methods(http.MethodPost)
	admin.HandleFunc("/tags/{id}", s.handleUpdateTag).Methods(http.MethodPatch)
	admin.HandleFunc("/tags/{id}", s.handleDeleteTag).Methods(http.MethodDelete)
	admin.HandleFunc("/kids/{id}/favorites", s.handleAdminListKidFavorites).Methods(http.MethodGet)
	admin.HandleFunc("/kids/{id}/favorites/{itemId}", s.handleAdminAddKidFavorite).Methods(http.MethodPut)
	admin.HandleFunc("/kids/{id}/favorites/{itemId}", s.handleAdminRemoveKidFavorite).Methods(http.MethodDelete)
	admin.HandleFunc("/profiles/{id}/tag-filters", s.handleAdminListProfileTagFilters).Methods(http.MethodGet)
	admin.HandleFunc("/profiles/{id}/tag-filters", s.handleAdminPutProfileTagFilters).Methods(http.MethodPut)
	admin.HandleFunc("/profiles/{id}/tag-filters/{tagId}", s.handleAdminDeleteProfileTagFilter).Methods(http.MethodDelete)
	admin.HandleFunc("/profiles/{id}/layout", s.handleAdminSetProfileLayout).Methods(http.MethodPut)
	admin.HandleFunc("/layouts", s.handleAdminListLayouts).Methods(http.MethodGet)
	admin.HandleFunc("/layouts", s.handleAdminCreateLayout).Methods(http.MethodPost)
	admin.HandleFunc("/layouts/{id}", s.handleAdminGetLayout).Methods(http.MethodGet)
	admin.HandleFunc("/layouts/{id}", s.handleAdminUpdateLayout).Methods(http.MethodPatch)
	admin.HandleFunc("/layouts/{id}", s.handleAdminDeleteLayout).Methods(http.MethodDelete)
	admin.HandleFunc("/layouts/{id}/clone", s.handleAdminCloneLayout).Methods(http.MethodPost)
	admin.HandleFunc("/layouts/{id}/default", s.handleAdminSetDefaultLayout).Methods(http.MethodPost)
	admin.HandleFunc("/layouts/{id}/preview", s.handleAdminLayoutPreview).Methods(http.MethodGet)
	admin.HandleFunc("/layouts/{id}/rows", s.handleAdminAppendRow).Methods(http.MethodPost)
	admin.HandleFunc("/layouts/{id}/rows/order", s.handleAdminReorderRows).Methods(http.MethodPut)
	admin.HandleFunc("/layouts/{id}/rows/{rowId}", s.handleAdminUpdateRow).Methods(http.MethodPatch)
	admin.HandleFunc("/layouts/{id}/rows/{rowId}", s.handleAdminDeleteRow).Methods(http.MethodDelete)
	admin.HandleFunc("/dev/refresh-layout-cache", s.handleAdminRefreshLayoutCache).Methods(http.MethodPost)
	admin.HandleFunc("/api-keys", s.handleAdminListAPIKeys).Methods(http.MethodGet)
	admin.HandleFunc("/api-keys", s.handleAdminCreateAPIKey).Methods(http.MethodPost)
	admin.HandleFunc("/api-keys/{id}", s.handleAdminDeleteAPIKey).Methods(http.MethodDelete)
	admin.HandleFunc("/api-keys/{id}/revoke", s.handleAdminRevokeAPIKey).Methods(http.MethodPost)
	admin.HandleFunc("/api-keys/{id}/log", s.handleAdminListAccessLog).Methods(http.MethodGet)
	admin.HandleFunc("/api-access-log", s.handleAdminListAccessLog).Methods(http.MethodGet)
	admin.HandleFunc("/override", s.handleAdminOverrideStatus).Methods(http.MethodGet)
	admin.HandleFunc("/override/pin", s.handleAdminSetOverridePIN).Methods(http.MethodPost)
	admin.HandleFunc("/override/clear-lockout", s.handleAdminClearOverrideLockout).Methods(http.MethodPost)
	admin.HandleFunc("/settings", s.handleAdminListSettings).Methods(http.MethodGet)
	admin.HandleFunc("/settings", s.handleAdminSetSetting).Methods(http.MethodPut)
	admin.HandleFunc("/profiles/{id}/time-limits", s.handleAdminProfileTimeLimits).Methods(http.MethodGet)
	admin.HandleFunc("/profiles/{id}/time-limits", s.handleAdminUpdateProfileTimeLimits).Methods(http.MethodPut)
	admin.HandleFunc("/profiles/{id}/content-overrides", s.handleAdminListContentOverrides).Methods(http.MethodGet)
	admin.HandleFunc("/profiles/{id}/content-overrides/{itemId}", s.handleAdminUpsertContentOverride).Methods(http.MethodPut)
	admin.HandleFunc("/kids/{id}/time-status", s.handleAdminKidTimeStatus).Methods(http.MethodGet)
	admin.HandleFunc("/profiles/{id}/body-breaks", s.handleAdminProfileBodyBreaks).Methods(http.MethodGet)
	admin.HandleFunc("/profiles/{id}/body-breaks", s.handleAdminUpdateProfileBodyBreaks).Methods(http.MethodPut)
	admin.HandleFunc("/profiles/{id}/viewing-controls", s.handleAdminProfileViewingControls).Methods(http.MethodGet)
	admin.HandleFunc("/profiles/{id}/viewing-controls", s.handleAdminUpdateProfileViewingControls).Methods(http.MethodPut)
	admin.HandleFunc("/profiles/{id}/modes", s.handleAdminListModes).Methods(http.MethodGet)
	admin.HandleFunc("/profiles/{id}/modes", s.handleAdminCreateMode).Methods(http.MethodPost)
	admin.HandleFunc("/modes/{id}", s.handleAdminUpdateMode).Methods(http.MethodPatch)
	admin.HandleFunc("/modes/{id}", s.handleAdminDeleteMode).Methods(http.MethodDelete)
	admin.HandleFunc("/profiles/{id}/channels", s.handleAdminListChannels).Methods(http.MethodGet)
	admin.HandleFunc("/profiles/{id}/channels", s.handleAdminCreateChannel).Methods(http.MethodPost)
	admin.HandleFunc("/channels/{id}", s.handleAdminUpdateChannel).Methods(http.MethodPatch)
	admin.HandleFunc("/channels/{id}", s.handleAdminDeleteChannel).Methods(http.MethodDelete)

	// Kids API. /auth/login is unauthenticated (it IS the auth flow); the
	// rest accept either an admin session cookie (parent previewing) or
	// the bearer token returned by /auth/login. OptionalMiddleware lets
	// the admin path coexist with the bearer path.
	api.HandleFunc("/kids/auth/login", s.handleKidsLogin).Methods(http.MethodPost)
	kids := api.PathPrefix("/kids").Subrouter()
	kids.Use(s.auth.OptionalMiddleware)
	kids.HandleFunc("/library", s.handleKidsLibrary).Methods(http.MethodGet)
	kids.HandleFunc("/browse", s.handleKidsBrowse).Methods(http.MethodGet)
	kids.HandleFunc("/items/{id}", s.handleKidsItem).Methods(http.MethodGet)
	kids.HandleFunc("/items/{id}/image", s.handleKidsImage).Methods(http.MethodGet)
	kids.HandleFunc("/items/{id}/stream", s.handleKidsStream).Methods(http.MethodGet)
	kids.HandleFunc("/items/{id}/next-up", s.handleKidsNextUp).Methods(http.MethodGet)
	kids.HandleFunc("/series/{id}/episodes", s.handleKidsSeriesEpisodes).Methods(http.MethodGet)
	kids.HandleFunc("/playback/start", s.handleKidsPlaybackStart).Methods(http.MethodPost)
	kids.HandleFunc("/playback/progress", s.handleKidsPlaybackProgress).Methods(http.MethodPost)
	kids.HandleFunc("/playback/stopped", s.handleKidsPlaybackStopped).Methods(http.MethodPost)
	kids.HandleFunc("/playback/stop-encoding", s.handleKidsStopEncoding).Methods(http.MethodPost)
	kids.HandleFunc("/override/verify-pin", s.handleKidsOverrideVerifyPIN).Methods(http.MethodPost)
	kids.HandleFunc("/override/refresh", s.handleKidsOverrideRefresh).Methods(http.MethodPost)
	kids.HandleFunc("/override/end", s.handleKidsOverrideEnd).Methods(http.MethodPost)
	kids.HandleFunc("/override/items/{id}/favorite", s.handleKidsOverrideFavorite).Methods(http.MethodPost)
	kids.HandleFunc("/override/items/{id}/tags", s.handleKidsOverrideTagsList).Methods(http.MethodGet)
	kids.HandleFunc("/override/items/{id}/tags", s.handleKidsOverrideTags).Methods(http.MethodPut)
	kids.HandleFunc("/override/items/{id}/hide", s.handleKidsOverrideHide).Methods(http.MethodPost)
	kids.HandleFunc("/override/items/{id}/mark/{state}", s.handleKidsOverrideMarkPlayed).Methods(http.MethodPost)
	kids.HandleFunc("/override/items/{id}/qr", s.handleKidsOverrideQR).Methods(http.MethodGet)
	kids.HandleFunc("/override/grant-time", s.handleKidsOverrideGrantTime).Methods(http.MethodPost)
	kids.HandleFunc("/time-status", s.handleKidsTimeStatus).Methods(http.MethodGet)
	kids.HandleFunc("/items/{id}/can-play", s.handleKidsCanPlay).Methods(http.MethodGet)
	kids.HandleFunc("/body-break-status", s.handleKidsBodyBreakStatus).Methods(http.MethodGet)
	kids.HandleFunc("/override/skip-break", s.handleKidsOverrideSkipBreak).Methods(http.MethodPost)
	kids.HandleFunc("/viewing-state", s.handleKidsViewingState).Methods(http.MethodGet)
	kids.HandleFunc("/override/viewing/{action}", s.handleKidsOverrideSetViewing).Methods(http.MethodPost)
	kids.HandleFunc("/active-mode", s.handleKidsActiveMode).Methods(http.MethodGet)
	kids.HandleFunc("/override/set-mode", s.handleKidsOverrideSetMode).Methods(http.MethodPost)
	kids.HandleFunc("/channels", s.handleKidsChannels).Methods(http.MethodGet)

	// Static SPAs. Two distinct apps live under two distinct prefixes:
	//   /player/*  - the kid streaming client (was /kids/*)
	//   /manage/*  - the parent / admin curation app (was /)
	// Old /kids/* URLs and bare / both redirect into the new layout
	// so existing bookmarks / TV deeplinks keep working.
	s.router.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/manage", http.StatusMovedPermanently)
	}).Methods(http.MethodGet)
	s.router.PathPrefix("/kids").HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := "/player" + strings.TrimPrefix(r.URL.Path, "/kids")
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	})
	if s.kidsAssets != nil {
		kids, err := newSPA(s.kidsAssets, "web/kids/dist")
		if err == nil {
			s.router.PathPrefix("/player").Handler(http.StripPrefix("/player", kids))
		} else {
			s.logger.Warn().Err(err).Msg("kids SPA disabled")
		}
	}
	if s.adminAssets != nil {
		admin, err := newSPA(s.adminAssets, "web/admin/dist")
		if err == nil {
			s.router.PathPrefix("/manage").Handler(http.StripPrefix("/manage", admin))
		} else {
			s.logger.Warn().Err(err).Msg("admin SPA disabled")
		}
	}

	// Catch-all 404: anything not matched by the routes above gets
	// either a JSON 404 (for /api/*) or a styled HTML page (otherwise).
	// The styled page links into /manage so the user can navigate
	// back without typing.
	s.router.NotFoundHandler = http.HandlerFunc(s.handleNotFound)
}

func (s *Server) handleNotFound(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found"}`))
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(notFoundHTML))
}

// Self-contained 404 page. Inline CSS so it works even when the
// admin SPA bundle is broken / unbuilt - this is a last-resort
// surface and shouldn't depend on anything but the standard library.
const notFoundHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>404 - Jellybean</title>
  <style>
    :root { color-scheme: dark; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background: #0c0d12;
      color: #e8e8ea;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    main {
      min-height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 1.5rem;
      text-align: center;
    }
    .code {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      color: #8084ff;
      font-size: 5rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      margin-bottom: 0.4rem;
    }
    h1 {
      margin: 0 0 0.6rem;
      font-size: 1.6rem;
      font-weight: 600;
    }
    p {
      margin: 0 0 1.5rem;
      color: #98989f;
      max-width: 32rem;
      line-height: 1.5;
    }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
      justify-content: center;
    }
    a {
      display: inline-block;
      padding: 0.55rem 1rem;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #e8e8ea;
      text-decoration: none;
      font-size: 0.95rem;
      transition: background 0.1s, border-color 0.1s;
    }
    a:hover {
      background: rgba(255, 255, 255, 0.04);
      border-color: rgba(255, 255, 255, 0.25);
    }
    a.primary {
      background: #8084ff;
      color: #111;
      border-color: #8084ff;
      font-weight: 600;
    }
    a.primary:hover { filter: brightness(1.08); background: #8084ff; }
  </style>
</head>
<body>
  <main>
    <div class="code">404</div>
    <h1>Page not found</h1>
    <p>The page you're looking for doesn't exist on this Jellybean instance. It may have moved or the link could be stale.</p>
    <div class="links">
      <a href="/manage" class="primary">Open admin</a>
      <a href="/player">Player</a>
    </div>
  </main>
</body>
</html>
`

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

// bearerAdapter satisfies auth.BearerVerifier by delegating to the
// curation store. We keep curation out of the auth package by going
// through this small interface adapter.
type bearerAdapter struct {
	store *curation.Store
}

func (b *bearerAdapter) VerifyBearer(ctx context.Context, token string) (*auth.APIKeyContext, error) {
	key, err := b.store.VerifyAPIKey(ctx, token)
	if err != nil {
		return nil, err
	}
	// Bumping last_used_at on every successful auth keeps the admin
	// UI honest. Errors here aren't fatal - the request still
	// proceeds; we just log.
	_ = b.store.UpdateAPIKeyLastUsed(ctx, key.ID)
	return &auth.APIKeyContext{ID: key.ID, Name: key.Name}, nil
}

func (b *bearerAdapter) NoteBearerUsed(keyID int64, method, path string, status int) {
	b.store.LogAPIAccess(keyID, method, path, status)
}

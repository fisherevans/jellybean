// Command jellybean is the entrypoint for the Jellybean server.
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"

	jellybean "github.com/fisherevans/jellybean"
	"github.com/fisherevans/jellybean/internal/config"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/db"
	"github.com/fisherevans/jellybean/internal/itemcache"
	"github.com/fisherevans/jellybean/internal/jellyfin"
	"github.com/fisherevans/jellybean/internal/server"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if err := healthcheck(); err != nil {
			fmt.Fprintf(os.Stderr, "healthcheck failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

// healthcheck is the binary's "is this container alive?" subcommand. Called
// by Docker's HEALTHCHECK directive; works inside distroless because it
// reuses the same binary instead of needing a shell or wget.
func healthcheck() error {
	port := os.Getenv("JELLYBEAN_PORT")
	if port == "" {
		port = "8080"
	}
	cli := &http.Client{Timeout: 3 * time.Second}
	res, err := cli.Get(fmt.Sprintf("http://127.0.0.1:%s/api/health", port))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", res.StatusCode)
	}
	return nil
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	logger := newLogger(cfg)
	logger.Info().
		Str("env", cfg.Env).
		Int("port", cfg.Port).
		Str("jellyfin_url", cfg.JellyfinURL).
		Msg("jellybean starting")

	jf := jellyfin.New(cfg.JellyfinURL, cfg.JellyfinAPIKey, jellyfin.WithPublicURL(cfg.JellyfinPublicURL))

	startupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	info, err := jf.SystemInfo(startupCtx)
	if err != nil {
		return fmt.Errorf("connect to jellyfin at %s: %w", cfg.JellyfinURL, err)
	}
	if err := jellyfin.CheckVersion(info.Version); err != nil {
		return err
	}
	logger.Info().
		Str("version", info.Version).
		Str("server_name", info.ServerName).
		Msg("jellyfin connected")

	conn, err := db.Open(cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer conn.Close()
	logger.Info().Str("path", cfg.DBPath).Msg("database opened")

	// itemcache mirrors the Movie + Series subset of Jellyfin's
	// catalog into SQLite so the admin items list + kid library +
	// browse decorate paths don't have to round-trip Jellyfin. On a
	// cold boot the table is empty and we run one synchronous Refresh
	// before listening so the first request doesn't hit an empty
	// cache. On a warm boot we let the HTTP server come up immediately
	// and refresh in the background.
	cache := itemcache.New(conn, jf, logger)
	// Wire the catalog_version bumper so a Refresh delta invalidates
	// the kid-facing ETag salt. The same wiring also runs inside
	// server.New for tests that pass a Cache; here it covers the
	// initial cold-boot Refresh that fires before server.New does.
	cache.SetBumper(curation.NewStore(conn))
	cacheCtx, cancelCache := context.WithCancel(context.Background())
	defer cancelCache()
	emptyCtx, cancelEmpty := context.WithTimeout(context.Background(), 10*time.Second)
	cacheEmpty, err := cache.IsEmpty(emptyCtx)
	cancelEmpty()
	if err != nil {
		return fmt.Errorf("itemcache state: %w", err)
	}
	if cacheEmpty {
		logger.Info().Msg("cache empty - running synchronous initial refresh")
		initCtx, cancelInit := context.WithTimeout(context.Background(), 5*time.Minute)
		if err := cache.Refresh(initCtx); err != nil {
			logger.Error().Err(err).Msg("initial itemcache refresh failed")
		}
		cancelInit()
	}

	// Assets are the go:embed'd builds by default. If JELLYBEAN_WEB_DIR is
	// set (dev fast loop), serve them from that directory on disk instead so
	// an rsync'd rebuild shows up on reload without rebuilding the image.
	var adminAssets, kidsAssets fs.FS = jellybean.AdminDist, jellybean.KidsDist
	if cfg.WebDir != "" {
		adminAssets = os.DirFS(cfg.WebDir)
		kidsAssets = os.DirFS(cfg.WebDir)
		logger.Info().Str("web_dir", cfg.WebDir).Msg("serving web from disk (dev)")
	}

	srv := server.New(server.Options{
		Config:          cfg,
		Logger:          logger,
		Jellyfin:        jf,
		DB:              conn,
		Cache:           cache,
		JellyfinVersion: info.Version,
		AdminAssets:     adminAssets,
		KidsAssets:      kidsAssets,
	})
	httpSrv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info().Int("port", cfg.Port).Msg("listening")
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	// Sweep the categorizations table for items that have disappeared
	// from Jellyfin since the daemon last ran. Backgrounded with a
	// generous timeout so a slow Jellyfin doesn't delay boot. See
	// Server.RunStartupReconcile for the cache-invalidation rationale.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		srv.RunStartupReconcile(ctx)
	}()

	// Warm-boot: kick off a Refresh in the background so the next
	// tick has fresh data without delaying ListenAndServe. Cold-boot
	// already ran one synchronously above, so skip the duplicate.
	if !cacheEmpty {
		go func() {
			refreshCtx, cancel := context.WithTimeout(cacheCtx, 5*time.Minute)
			defer cancel()
			if err := cache.Refresh(refreshCtx); err != nil {
				logger.Warn().Err(err).Msg("background itemcache refresh failed")
			}
		}()
	}

	// Periodic refresh ticker. Cadence comes from
	// JELLYBEAN_METADATA_CACHE_TTL (default 5m). Exits when cacheCtx
	// is cancelled at shutdown.
	go func() {
		ticker := time.NewTicker(cfg.MetadataCacheTTL)
		defer ticker.Stop()
		for {
			select {
			case <-cacheCtx.Done():
				return
			case <-ticker.C:
				refreshCtx, cancel := context.WithTimeout(cacheCtx, 5*time.Minute)
				if err := cache.Refresh(refreshCtx); err != nil {
					logger.Warn().Err(err).Msg("periodic itemcache refresh failed")
				}
				cancel()
			}
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		return fmt.Errorf("http server: %w", err)
	case sig := <-sigCh:
		logger.Info().Str("signal", sig.String()).Msg("shutting down")
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelShutdown()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	return nil
}

func newLogger(cfg *config.Config) zerolog.Logger {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	if cfg.IsDev() {
		return zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339}).
			With().Timestamp().Logger()
	}
	return zerolog.New(os.Stderr).With().Timestamp().Logger()
}

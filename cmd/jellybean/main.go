// Command jellybean is the entrypoint for the Jellybean server.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"

	jellybean "github.com/fisherevans/jellybean"
	"github.com/fisherevans/jellybean/internal/config"
	"github.com/fisherevans/jellybean/internal/db"
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
		Bool("tag_mirror", cfg.JellyfinTagMirror).
		Msg("jellybean starting")

	jf := jellyfin.New(cfg.JellyfinURL, cfg.JellyfinAPIKey)

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

	srv := server.New(server.Options{
		Config:          cfg,
		Logger:          logger,
		Jellyfin:        jf,
		DB:              conn,
		JellyfinVersion: info.Version,
		AdminAssets:     jellybean.AdminDist,
		KidsAssets:      jellybean.KidsDist,
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

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

	"github.com/fisherevans/jellybean/internal/config"
	"github.com/fisherevans/jellybean/internal/jellyfin"
	"github.com/fisherevans/jellybean/internal/server"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
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

	srv := server.New(cfg, logger, jf, info.Version)
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

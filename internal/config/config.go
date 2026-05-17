// Package config loads Jellybean's configuration from environment variables.
//
// Configuration is read once at startup. Required variables fail fast with a
// clear error if missing. Optional variables fall back to documented defaults.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	JellyfinURL    string
	JellyfinAPIKey string
	Port           int
	DBPath         string
	SessionSecret  string
	Env            string
	// MetadataCacheTTL drives the cadence of the itemcache background
	// refresh ticker (see cmd/jellybean and internal/itemcache).
	// Defaults to 5m; override with JELLYBEAN_METADATA_CACHE_TTL
	// (any time.ParseDuration value, e.g. "1m", "10m", "1h").
	MetadataCacheTTL time.Duration
}

const (
	envJellyfinURL       = "JELLYFIN_URL"
	envJellyfinAPIKey    = "JELLYFIN_API_KEY"
	envPort              = "JELLYBEAN_PORT"
	envDBPath            = "JELLYBEAN_DB_PATH"
	envSessionSecret     = "JELLYBEAN_SESSION_SECRET"
	envEnv               = "JELLYBEAN_ENV"
	envMetadataCacheTTL  = "JELLYBEAN_METADATA_CACHE_TTL"
	defaultMetadataCache = 5 * time.Minute
)

func Load() (*Config, error) {
	cfg := &Config{
		Port:             8080,
		DBPath:           "./jellybean.db",
		Env:              "production",
		MetadataCacheTTL: defaultMetadataCache,
	}

	var missing []string

	cfg.JellyfinURL = strings.TrimRight(os.Getenv(envJellyfinURL), "/")
	if cfg.JellyfinURL == "" {
		missing = append(missing, envJellyfinURL)
	}

	cfg.JellyfinAPIKey = os.Getenv(envJellyfinAPIKey)
	if cfg.JellyfinAPIKey == "" {
		missing = append(missing, envJellyfinAPIKey)
	}

	cfg.SessionSecret = os.Getenv(envSessionSecret)
	if cfg.SessionSecret == "" {
		missing = append(missing, envSessionSecret)
	}

	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required environment variables: %s", strings.Join(missing, ", "))
	}

	if v := os.Getenv(envPort); v != "" {
		port, err := strconv.Atoi(v)
		if err != nil || port <= 0 || port > 65535 {
			return nil, fmt.Errorf("%s must be a valid port (1-65535), got %q", envPort, v)
		}
		cfg.Port = port
	}

	if v := os.Getenv(envDBPath); v != "" {
		cfg.DBPath = v
	}

	if v := os.Getenv(envEnv); v != "" {
		cfg.Env = v
	}

	if v := os.Getenv(envMetadataCacheTTL); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return nil, fmt.Errorf("%s must be a positive duration (e.g. 5m), got %q", envMetadataCacheTTL, v)
		}
		cfg.MetadataCacheTTL = d
	}

	return cfg, nil
}

func (c *Config) IsDev() bool {
	return c.Env == "dev" || c.Env == "development"
}

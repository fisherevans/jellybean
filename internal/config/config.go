// Package config loads Jellybean's configuration from environment variables.
//
// Configuration is read once at startup. Required variables fail fast with a
// clear error if missing. Optional variables fall back to documented defaults.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	JellyfinURL           string
	JellyfinAPIKey        string
	Port                  int
	DBPath                string
	SessionSecret         string
	JellyfinTagMirror     bool
	Env                   string
	KidsKeys              map[string]string
}

const (
	envJellyfinURL           = "JELLYFIN_URL"
	envJellyfinAPIKey        = "JELLYFIN_API_KEY"
	envPort                  = "JELLYBEAN_PORT"
	envDBPath                = "JELLYBEAN_DB_PATH"
	envSessionSecret         = "JELLYBEAN_SESSION_SECRET"
	envJellyfinTagMirror     = "JELLYBEAN_JELLYFIN_TAG_MIRROR"
	envEnv                   = "JELLYBEAN_ENV"
	envKidsKeys              = "JELLYBEAN_KIDS_KEYS"
)

func Load() (*Config, error) {
	cfg := &Config{
		Port:     8080,
		DBPath:   "./jellybean.db",
		Env:      "production",
		KidsKeys: map[string]string{},
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

	if v := os.Getenv(envJellyfinTagMirror); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return nil, fmt.Errorf("%s must be a boolean, got %q", envJellyfinTagMirror, v)
		}
		cfg.JellyfinTagMirror = b
	}

	if v := os.Getenv(envEnv); v != "" {
		cfg.Env = v
	}

	if v := os.Getenv(envKidsKeys); v != "" {
		keys, err := parseKidsKeys(v)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", envKidsKeys, err)
		}
		cfg.KidsKeys = keys
	}

	return cfg, nil
}

// parseKidsKeys parses a comma-separated list of "apiKey=jellyfinUserId" pairs.
// This is a temporary mechanism for M1; real key issuance lands in M2.
func parseKidsKeys(s string) (map[string]string, error) {
	out := map[string]string{}
	for _, pair := range strings.Split(s, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		eq := strings.Index(pair, "=")
		if eq <= 0 || eq == len(pair)-1 {
			return nil, errors.New(`expected format "apiKey=jellyfinUserId,apiKey=jellyfinUserId"`)
		}
		out[pair[:eq]] = pair[eq+1:]
	}
	return out, nil
}

func (c *Config) IsDev() bool {
	return c.Env == "dev" || c.Env == "development"
}

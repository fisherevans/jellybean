package config

import (
	"testing"
)

func TestLoad(t *testing.T) {
	required := map[string]string{
		"JELLYFIN_URL":            "http://jellyfin.local:8096",
		"JELLYFIN_API_KEY":        "abc123",
		"JELLYBEAN_SESSION_SECRET": "supersecret",
	}

	tests := []struct {
		name    string
		env     map[string]string
		wantErr bool
		check   func(t *testing.T, c *Config)
	}{
		{
			name: "required vars only",
			env:  required,
			check: func(t *testing.T, c *Config) {
				if c.Port != 8080 {
					t.Errorf("Port = %d, want 8080", c.Port)
				}
				if c.DBPath != "./jellybean.db" {
					t.Errorf("DBPath = %q, want ./jellybean.db", c.DBPath)
				}
				if c.JellyfinTagMirror {
					t.Error("JellyfinTagMirror should default to false")
				}
				if c.JellyfinURL != "http://jellyfin.local:8096" {
					t.Errorf("JellyfinURL = %q", c.JellyfinURL)
				}
			},
		},
		{
			name: "trailing slash stripped from URL",
			env: merge(required, map[string]string{
				"JELLYFIN_URL": "http://jellyfin.local:8096/",
			}),
			check: func(t *testing.T, c *Config) {
				if c.JellyfinURL != "http://jellyfin.local:8096" {
					t.Errorf("JellyfinURL = %q, want trailing slash stripped", c.JellyfinURL)
				}
			},
		},
		{
			name: "missing required",
			env: map[string]string{
				"JELLYFIN_URL": "http://jellyfin.local:8096",
			},
			wantErr: true,
		},
		{
			name: "invalid port",
			env: merge(required, map[string]string{
				"JELLYBEAN_PORT": "not-a-number",
			}),
			wantErr: true,
		},
		{
			name: "port out of range",
			env: merge(required, map[string]string{
				"JELLYBEAN_PORT": "99999",
			}),
			wantErr: true,
		},
		{
			name: "tag mirror enabled",
			env: merge(required, map[string]string{
				"JELLYBEAN_JELLYFIN_TAG_MIRROR": "true",
			}),
			check: func(t *testing.T, c *Config) {
				if !c.JellyfinTagMirror {
					t.Error("JellyfinTagMirror should be true")
				}
			},
		},
		{
			name: "dev env detected",
			env: merge(required, map[string]string{
				"JELLYBEAN_ENV": "dev",
			}),
			check: func(t *testing.T, c *Config) {
				if !c.IsDev() {
					t.Error("expected IsDev to be true")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for k := range allEnvKeys {
				t.Setenv(k, "")
			}
			for k, v := range tt.env {
				t.Setenv(k, v)
			}
			cfg, err := Load()
			if (err != nil) != tt.wantErr {
				t.Fatalf("Load() error = %v, wantErr = %v", err, tt.wantErr)
			}
			if err == nil && tt.check != nil {
				tt.check(t, cfg)
			}
		})
	}
}

var allEnvKeys = map[string]struct{}{
	"JELLYFIN_URL":                  {},
	"JELLYFIN_API_KEY":              {},
	"JELLYBEAN_PORT":                {},
	"JELLYBEAN_DB_PATH":             {},
	"JELLYBEAN_SESSION_SECRET":      {},
	"JELLYBEAN_JELLYFIN_TAG_MIRROR": {},
	"JELLYBEAN_ENV":                 {},
}

func merge(maps ...map[string]string) map[string]string {
	out := map[string]string{}
	for _, m := range maps {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

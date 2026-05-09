package curation

// Registry of cross-cutting app_settings keys the admin UI is allowed
// to read and mutate. The storage layer (AppSettingGet / AppSettingSet)
// is intentionally schemaless; this list is the policy gate that keeps
// the /api/admin/settings surface from turning into an arbitrary k/v
// poke endpoint.
//
// Future milestones (M10/M11/M12) will append entries here when they
// introduce new global settings.

// SettingDef describes one admin-visible app_settings key.
type SettingDef struct {
	// Key is the column value used in the app_settings table.
	Key string
	// Description is a short human-readable note about what the
	// setting controls. Surface this in admin tooling if useful;
	// it's not currently rendered in the UI.
	Description string
}

// KnownSettings enumerates every app_settings key the admin endpoint
// is allowed to read or write. Order is not significant.
var KnownSettings = []SettingDef{
	{
		Key:         "public_url",
		Description: "Externally reachable base URL for Jellybean. Used by the kid client's QR-code generator (M9 override deep-links).",
	},
}

// IsKnownSetting reports whether key is registered. Linear scan; the
// list is small.
func IsKnownSetting(key string) bool {
	for _, s := range KnownSettings {
		if s.Key == key {
			return true
		}
	}
	return false
}

// KnownSettingKeys returns just the keys, in registry order. Handy
// for iterating in handlers that don't need the full SettingDef.
func KnownSettingKeys() []string {
	out := make([]string, len(KnownSettings))
	for i, s := range KnownSettings {
		out[i] = s.Key
	}
	return out
}

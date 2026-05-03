package server

import (
	"errors"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/curation"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

const kidsKeyHeader = "X-Jellybean-Key"

// kidsContext describes who is hitting a /api/kids/* endpoint and which
// Jellyfin user their requests should be attributed to.
type kidsContext struct {
	// JellyfinUserID is the user the request will appear as on Jellyfin.
	JellyfinUserID string
	// JellyfinToken is the per-user access token for stream URLs. Empty
	// when we don't have one (admin path or env-var fallback); callers
	// fall back to the service-account key.
	JellyfinToken string
	// Source distinguishes the auth path: "admin" (session cookie),
	// "kid_db" (DB-backed key), or "kid_env" (deprecated env-var stub).
	Source string
	// Label is a short identifier for logs.
	Label string
}

// resolveKidsAuth accepts a logged-in admin session OR a kid API key. The
// key is hashed and looked up against the DB-backed kids table first; the
// JELLYBEAN_KIDS_KEYS env var is a deprecated fallback retained for one
// release so M1 setups don't break instantly. Admin sessions short-circuit
// the key flow so testing from a logged-in browser works without
// provisioning a kid.
//
// Returns nil if no acceptable auth was presented; callers should 401.
func (s *Server) resolveKidsAuth(r *http.Request) *kidsContext {
	if sess := auth.SessionFromContext(r.Context()); sess != nil {
		return &kidsContext{
			JellyfinUserID: sess.UserID,
			Source:         "admin",
			Label:          sess.UserName,
		}
	}
	key := r.Header.Get(kidsKeyHeader)
	if key == "" {
		return nil
	}
	if entry, err := s.curation.FindKidByAPIKey(r.Context(), key); err == nil {
		return &kidsContext{
			JellyfinUserID: entry.JellyfinUserID,
			JellyfinToken:  entry.JellyfinToken,
			Source:         "kid_db",
			Label:          entry.Name,
		}
	} else if !errors.Is(err, curation.ErrKidNotFound) {
		s.logger.Error().Err(err).Msg("kid db lookup")
	}
	if userID, ok := s.cfg.KidsKeys[key]; ok {
		s.logger.Warn().Str("jellyfin_user_id", userID).Msg("using deprecated JELLYBEAN_KIDS_KEYS env var; migrate to DB-backed kids")
		return &kidsContext{
			JellyfinUserID: userID,
			Source:         "kid_env",
			Label:          userID,
		}
	}
	return nil
}

// handleKidsStream returns a direct-play stream URL for the requested item.
// Auth: either an admin session cookie or a valid X-Jellybean-Key.
//
// M1 limitation: the returned URL is signed with the service-account API
// key rather than a per-user token, so Jellyfin's playback tracking attributes
// to the service account. This is good enough to verify the streaming chain;
// per-user attribution lands when we mint real Jellyfin user tokens during
// kid profile creation.
func (s *Server) handleKidsStream(w http.ResponseWriter, r *http.Request) {
	kc := s.resolveKidsAuth(r)
	if kc == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}

	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}

	item, err := s.jellyfin.GetItem(r.Context(), id)
	if err != nil {
		if errors.Is(err, jellyfin.ErrNotFound) {
			http.Error(w, "item not found", http.StatusNotFound)
			return
		}
		s.logger.Error().Err(err).Str("id", id).Msg("kids stream resolve")
		http.Error(w, "failed to resolve item", http.StatusBadGateway)
		return
	}

	// Per-user attribution: pass the kid's stored Jellyfin token if we have
	// one. For admin or env-var paths the token is empty and StreamURL
	// falls back to the configured service-account API key.
	streamURL := s.jellyfin.StreamURL(id, kc.JellyfinToken)

	s.logger.Info().
		Str("auth_source", kc.Source).
		Str("auth_label", kc.Label).
		Str("jellyfin_user_id", kc.JellyfinUserID).
		Bool("user_token_used", kc.JellyfinToken != "").
		Str("item_id", id).
		Str("item_name", item.Name).
		Msg("kids stream resolved")

	writeJSON(w, http.StatusOK, map[string]string{
		"streamUrl": streamURL,
		"itemId":    id,
		"itemName":  item.Name,
	})
}

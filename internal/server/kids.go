package server

import (
	"errors"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/auth"
	"github.com/fisherevans/jellybean/internal/jellyfin"
)

const kidsKeyHeader = "X-Jellybean-Key"

// kidsContext describes who is hitting a /api/kids/* endpoint and which
// Jellyfin user their requests should be attributed to.
type kidsContext struct {
	// JellyfinUserID is the user the request will appear as on Jellyfin
	// (today only used for logging; future per-user tokens use it for
	// playback attribution).
	JellyfinUserID string
	// Source is "admin" when the caller is a logged-in admin viewing the
	// kids UI, "kid" when authenticated via X-Jellybean-Key.
	Source string
	// Label is a short identifier for logs (admin name or kid key slug).
	Label string
}

// resolveKidsAuth accepts either a logged-in admin session or a kid API key.
// Admin session takes precedence so testing the kids UI from a browser that
// is already authenticated works without setting up a kid key.
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
	userID, ok := s.cfg.KidsKeys[key]
	if !ok {
		return nil
	}
	return &kidsContext{
		JellyfinUserID: userID,
		Source:         "kid",
		// Don't log the raw key; the user_id is enough for audit.
		Label: userID,
	}
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

	streamURL := s.jellyfin.StreamURL(id, "") // service-account fallback (see comment above)

	s.logger.Info().
		Str("auth_source", kc.Source).
		Str("auth_label", kc.Label).
		Str("jellyfin_user_id", kc.JellyfinUserID).
		Str("item_id", id).
		Str("item_name", item.Name).
		Msg("kids stream resolved")

	writeJSON(w, http.StatusOK, map[string]string{
		"streamUrl": streamURL,
		"itemId":    id,
		"itemName":  item.Name,
	})
}

package server

import (
	"errors"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

const kidsKeyHeader = "X-Jellybean-Key"

// handleKidsStream returns a direct-play stream URL for the requested item.
// The kid client authenticates with X-Jellybean-Key, which the M1 config
// maps to a Jellyfin user ID via env var. Real per-profile key issuance
// arrives with the curation web app in M2.
//
// M1 limitation: the returned URL is signed with the service-account API
// key rather than a per-user token, so Jellyfin's playback tracking attributes
// to the service account. This is good enough to verify the streaming chain;
// per-user attribution lands when we mint real Jellyfin user tokens during
// kid profile creation.
func (s *Server) handleKidsStream(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get(kidsKeyHeader)
	if key == "" {
		http.Error(w, "missing kid key", http.StatusUnauthorized)
		return
	}
	userID, ok := s.cfg.KidsKeys[key]
	if !ok {
		http.Error(w, "invalid kid key", http.StatusUnauthorized)
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
		Str("kid_user_id", userID).
		Str("item_id", id).
		Str("item_name", item.Name).
		Msg("kids stream resolved")

	writeJSON(w, http.StatusOK, map[string]string{
		"streamUrl": streamURL,
		"itemId":    id,
		"itemName":  item.Name,
	})
}

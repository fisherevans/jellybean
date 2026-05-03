package server

import (
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/gorilla/mux"

	"github.com/fisherevans/jellybean/internal/jellyfin"
)

// handleAdminImage proxies an image from Jellyfin so the browser doesn't
// need to know the Jellyfin URL or the service-account API key. Only Primary
// (poster), Backdrop (hero / scene capture), and Thumb (wide thumbnail)
// types are exposed; anything else returns 400.
//
// Cache-Control is overwritten authoritatively (Jellyfin's value is
// unreliable across versions). When the caller passes ?tag=<hash> -
// Jellyfin's content-addressed ImageTags hash - the response is treated
// as immutable for a week. Otherwise, a 1-day max-age fallback applies.
func (s *Server) handleAdminImage(w http.ResponseWriter, r *http.Request) {
	s.proxyJellyfinImage(w, r)
}

// handleKidsImage exposes the same proxy as the admin variant but gated by
// the kids auth resolver. Both serve the same upstream request signed with
// the service-account token; images aren't user-scoped in Jellyfin.
func (s *Server) handleKidsImage(w http.ResponseWriter, r *http.Request) {
	if s.resolveKidsAuth(r) == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	s.proxyJellyfinImage(w, r)
}

func (s *Server) proxyJellyfinImage(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if id == "" {
		http.Error(w, "item id required", http.StatusBadRequest)
		return
	}

	imgType := r.URL.Query().Get("type")
	switch imgType {
	case "":
		imgType = "Primary"
	case "Primary", "Backdrop", "Thumb":
		// allowed
	default:
		http.Error(w, "image type must be Primary, Backdrop, or Thumb", http.StatusBadRequest)
		return
	}

	tag := r.URL.Query().Get("tag")
	width := r.URL.Query().Get("width")
	height := r.URL.Query().Get("height")

	// Cache headers + ETag are computed from the request alone (item id +
	// type + tag + render dims), so a client revisiting a poster can be
	// served a 304 without round-tripping to Jellyfin.
	etag := imageETag(id, imgType, tag, width, height)
	cacheControl := "public, max-age=86400"
	if tag != "" {
		cacheControl = "public, max-age=604800, immutable"
	}

	if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", cacheControl)
		w.WriteHeader(http.StatusNotModified)
		return
	}

	q := url.Values{}
	if width != "" {
		if n, err := strconv.Atoi(width); err == nil && n > 0 && n <= 2000 {
			q.Set("fillWidth", strconv.Itoa(n))
		}
	}
	if height != "" {
		if n, err := strconv.Atoi(height); err == nil && n > 0 && n <= 2000 {
			q.Set("fillHeight", strconv.Itoa(n))
		}
	}
	q.Set("quality", "80")

	upstream := s.cfg.JellyfinURL + "/Items/" + url.PathEscape(id) + "/Images/" + imgType
	if encoded := q.Encode(); encoded != "" {
		upstream += "?" + encoded
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", jellyfinAuthHeader(s.cfg.JellyfinAPIKey))

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		s.logger.Warn().Err(err).Str("id", id).Msg("image upstream")
		http.Error(w, "image fetch failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		http.Error(w, "image not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "upstream returned "+resp.Status, http.StatusBadGateway)
		return
	}

	// Pass through payload metadata from upstream, but Cache-Control +
	// ETag are authoritative on our side: Jellyfin's values aren't
	// reliable across versions, and we can answer 304s ourselves.
	for _, h := range []string{"Content-Type", "Content-Length", "Last-Modified"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("ETag", etag)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// imageETag returns a weak ETag derived from the request signature so two
// requests for the same content-addressed image produce the same tag
// regardless of upstream behavior.
func imageETag(id, imgType, tag, width, height string) string {
	sum := sha256.Sum256([]byte(id + "|" + imgType + "|" + tag + "|" + width + "|" + height))
	return `W/"` + base64.RawURLEncoding.EncodeToString(sum[:]) + `"`
}

// jellyfinAuthHeader builds the same "MediaBrowser" auth header the
// jellyfin client sends for /Items requests. Re-exported via a small
// helper from the jellyfin package so the format stays in sync.
func jellyfinAuthHeader(token string) string {
	return jellyfin.AuthHeaderForServiceAccount(token)
}

package server

import (
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
// Cache headers come from Jellyfin and we forward them; tested in practice
// with Cache-Control: public, max-age=31536000 since Jellyfin's image data
// is content-addressed by ImageTags hash. The browser will cache hard.
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

	q := url.Values{}
	if v := r.URL.Query().Get("width"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 2000 {
			q.Set("fillWidth", strconv.Itoa(n))
		}
	}
	if v := r.URL.Query().Get("height"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 2000 {
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

	for _, h := range []string{"Content-Type", "Content-Length", "Cache-Control", "ETag", "Last-Modified"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "public, max-age=86400")
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// jellyfinAuthHeader builds the same "MediaBrowser" auth header the
// jellyfin client sends for /Items requests. Re-exported via a small
// helper from the jellyfin package so the format stays in sync.
func jellyfinAuthHeader(token string) string {
	return jellyfin.AuthHeaderForServiceAccount(token)
}

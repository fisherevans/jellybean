package server

import (
	"io/fs"
	"net/http"
	"strings"
)

// spaHandler serves a Vite-built single-page-app from an embed.FS subtree.
// It serves real files when present (CSS, JS, images, etc.) and falls back to
// index.html for any path that doesn't match a file, so client-side routing
// works.
type spaHandler struct {
	fsys     fs.FS // already rooted at the dist directory
	notFound []byte
	live     bool // re-read index.html per request (disk-served dev assets)
}

func newSPA(root fs.FS, distSubpath string, live bool) (*spaHandler, error) {
	sub, err := fs.Sub(root, distSubpath)
	if err != nil {
		return nil, err
	}
	h := &spaHandler{fsys: sub, live: live}
	if !live {
		// Cache index.html once for the embedded (prod) path. In live mode
		// it's read fresh each request so an rsync'd rebuild's new asset
		// hashes show up on the next reload without a restart.
		h.notFound, _ = fs.ReadFile(sub, "index.html")
	}
	return h, nil
}

func (s *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	clean := strings.TrimPrefix(r.URL.Path, "/")
	if clean == "" {
		s.serveIndex(w)
		return
	}
	f, err := s.fsys.Open(clean)
	if err != nil {
		s.serveIndex(w)
		return
	}
	stat, err := f.Stat()
	f.Close()
	if err != nil || stat.IsDir() {
		s.serveIndex(w)
		return
	}
	// Hashed assets under /assets/ are content-addressed and safe to cache
	// hard. Everything else (favicon, etc.) gets a short cache so updates
	// land within a minute without users having to hard-refresh.
	if strings.HasPrefix(clean, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=60")
	}
	http.FileServer(http.FS(s.fsys)).ServeHTTP(w, r)
}

// serveIndex always re-serves the latest index.html with no-cache so the
// next page load picks up new asset hashes after a deploy. Without this the
// browser can keep serving a stale index.html that points at deleted JS.
func (s *spaHandler) serveIndex(w http.ResponseWriter) {
	idx := s.notFound
	if s.live {
		// Read fresh from disk so a rebuilt index.html (new asset hashes)
		// is served without restarting the process.
		idx, _ = fs.ReadFile(s.fsys, "index.html")
	}
	if len(idx) == 0 {
		http.Error(w, "frontend not built; run `npm run build` in web/admin or web/kids", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.Write(idx)
}

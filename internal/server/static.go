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
}

func newSPA(root fs.FS, distSubpath string) (*spaHandler, error) {
	sub, err := fs.Sub(root, distSubpath)
	if err != nil {
		return nil, err
	}
	idx, _ := fs.ReadFile(sub, "index.html")
	return &spaHandler{fsys: sub, notFound: idx}, nil
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
	http.FileServer(http.FS(s.fsys)).ServeHTTP(w, r)
}

func (s *spaHandler) serveIndex(w http.ResponseWriter) {
	if len(s.notFound) == 0 {
		http.Error(w, "frontend not built; run `npm run build` in web/admin or web/kids", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(s.notFound)
}

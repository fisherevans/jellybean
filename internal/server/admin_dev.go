package server

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// handleAdminDevSaveBgSvg writes a posted SVG payload to
// web/kids/public/browse-bg-tile.svg so the bg editor at
// /player/bg-editor.html can persist tweaks back to the source
// file. Dev-only utility - the path is resolved relative to the
// running binary's working dir and only writes if it's a
// recognizable SVG. After write, the user has to vite-build +
// jb-restart to pick up the change in the embedded asset, since
// the kid client is served from the Go binary's go:embed dist/.
//
// Auth: admin session (the route is mounted under the admin API
// router which requires the session middleware).
func (s *Server) handleAdminDevSaveBgSvg(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB cap
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	content := strings.TrimSpace(string(body))
	if !strings.Contains(content, "<svg") || !strings.HasSuffix(content, "</svg>") {
		http.Error(w, "body must be an SVG document", http.StatusBadRequest)
		return
	}
	// Resolve the public-dir path from the working directory. jb
	// runs the binary from the project root; CI / production builds
	// don't ship this endpoint anyway (no source tree there to
	// write to).
	cwd, err := os.Getwd()
	if err != nil {
		http.Error(w, "getwd: "+err.Error(), http.StatusInternalServerError)
		return
	}
	target := filepath.Join(cwd, "web", "kids", "public", "browse-bg-tile.svg")
	// Sanity-check that the parent directory exists so we don't
	// silently create a nested tree somewhere unexpected.
	if _, err := os.Stat(filepath.Dir(target)); err != nil {
		http.Error(
			w,
			"public dir missing (run from project root?): "+err.Error(),
			http.StatusInternalServerError,
		)
		return
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		http.Error(w, "write: "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.logger.Info().Str("path", target).Int("bytes", len(content)).Msg("admin dev: bg svg saved")
	w.WriteHeader(http.StatusNoContent)
}

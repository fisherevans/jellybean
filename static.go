// Package jellybean exposes the embedded web app assets so the cmd/jellybean
// binary can ship as a single executable. The embed directives live at the
// repo root because Go's embed cannot escape its own package directory; the
// admin and kids Vite builds output to web/{admin,kids}/dist which then get
// baked in here.
//
// The embedded directories must contain at least a .gitkeep entry so that go
// build succeeds before any web build has run. Real assets land on top of
// the placeholder during Vite builds and inside the Dockerfile.
package jellybean

import "embed"

//go:embed all:web/admin/dist
var AdminDist embed.FS

//go:embed all:web/kids/dist
var KidsDist embed.FS

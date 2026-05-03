# Jellybean - project guide for Claude

Read this first when working in this repo. It points you at the canonical
product doc, explains how work is tracked, and lists the conventions that
should not be re-derived from scratch every session.

## Product context

Jellybean is a kid-focused Jellyfin streaming client plus a parent-focused
curation web app. Built and used in a personal home-server context (Synology +
existing *arr stack + Jellyfin behind a Cloudflare tunnel).

The full vision, decisions, and trade-offs are in
`docs/original-product-idea.md`. Read the relevant sections of that doc
before implementing - many alternatives have already been considered and
rejected with reasoning.

## Architecture at a glance

- One Go service running in a Docker container, sibling to Jellyfin (not a
  proxy in front of it).
- SQLite as Jellybean's source of truth for curation state.
- Two embedded web apps in the same Go binary:
  - `/` - parent curation web app (admin)
  - `/kids` - kids streaming client
- Parent auth: delegated to Jellyfin via `AuthenticateByName`; admin role
  required.
- Kids auth: per-profile API key stored on the TV, mapped server-side to a
  Jellyfin user.
- Catalog, metadata, and actual streaming always come from Jellyfin.
- Optional one-way tag mirror to Jellyfin (`JELLYBEAN_JELLYFIN_TAG_MIRROR`),
  off by default. Never read tags back as authoritative.

## Where work is tracked

Milestones and tasks live in GitHub, not in this repo.

- Milestones: `gh api repos/fisherevans/jellybean/milestones | jq '.[] | {number, title, state}'`
- Issues for the current milestone:
  `gh issue list --repo fisherevans/jellybean --milestone "M3: Kids client UI" --state open`
- Single issue: `gh issue view <number> --repo fisherevans/jellybean`

Current milestone: **M3: Kids client UI**.

### How to pick up an issue

1. List open issues in the current milestone (command above).
2. Pick one whose `Depends on:` issues are all closed.
3. Read the full issue body - acceptance criteria and implementation notes
   are intentional and load-bearing.
4. Read the cross-referenced sections of `docs/original-product-idea.md`.
5. Implement against the acceptance criteria. Do not expand scope beyond
   them without surfacing it.
6. Open a PR referencing the issue (`Closes #N`).

## Milestones (high level)

- **M1: End-to-end skeleton** (closed) - Go server scaffold, Jellyfin client,
  parent auth via Jellyfin, parent + kids streaming proof (HLS via hls.js),
  Docker image, CI publishing, dev runbook. 8 issues, all closed.
- **M2: Curation data model and parent web app** (closed) - SQLite curation
  schema, per-profile visibility (visible / hidden / unset), auto-
  categorization heuristics, parent web UI (sweep + triage with card-stack
  swipe gestures, activity, search), profile + kid management with per-kid
  Jellyfin tokens, both Movies and TV Series treated as first-class. 8
  issues, plus follow-up polish.
- **M3: Kids client UI** (current) - Profile picker on launch, browse grid
  mixing movies + series, "Continue Watching" with resume, D-pad focus
  management, playback with reporting back to Jellyfin so resume + watched
  state are populated, per-device DeviceId pass-through. 6 issues.
- **M3: Kids client UI** - profile picker, browse grid, D-pad focus
  management, recently watched / continue watching, playback with resume.
- **M4: Caching layer** - IndexedDB metadata cache, Cache API for artwork,
  content version etag, render-from-cache-then-refresh.
- **M5: TV deployment** - first real-TV target (Tizen or Google TV TBD at
  milestone start), packaging, sideload script, on-device validation.
- **M6: Optional Jellyfin tag mirror** - derived one-way tag export for
  visibility in Jellyfin's own UI.

Issues for milestones beyond the current one are intentionally not yet
defined. They get carved up after the previous milestone closes, informed
by what we learned.

When something we discover in the current milestone affects a future
milestone's scope, append it to that milestone's description on GitHub
(`gh api repos/fisherevans/jellybean/milestones/<N> -X PATCH -F description=@notes.txt`).
This way the context lives where it'll be read. Milestone descriptions
are worth a `gh api .../milestones/<N>` read before scoping the issues
for that milestone.

## Repo layout

```
cmd/jellybean/                # Go entrypoint, healthcheck subcommand
internal/config/              # env var loading
internal/server/              # HTTP routes, SPA handlers, admin/kids endpoints
internal/jellyfin/            # Jellyfin API client (auth, items, stream URL)
internal/auth/                # session store, login handlers, middleware, rate limit
internal/db/                  # SQLite connection + embedded migrations
internal/db/migrations/       # NNNN_*.sql, embedded via go:embed
web/admin/                    # Vite + React parent curation app
web/kids/                     # Vite + React kids streaming client
static.go                     # package jellybean - root-level embed of web/{admin,kids}/dist
scripts/jb                    # local dev daemon controller (see "Local dev")
examples/docker-compose.yml   # production drop-in alongside Jellyfin
docker-compose.dev.yml        # Dockerfile smoke-test overlay
Dockerfile                    # multi-stage, multi-arch, distroless static runtime
.github/workflows/build.yml   # test + multi-arch image push to GHCR
docs/                         # design docs and runbooks
.run/                         # gitignored: pid file, log, built binary, dev cookie
```

The embed lives at the project root because Go's `embed` cannot escape
its package directory and we want `web/` to stay top-level. `static.go`
is `package jellybean`, imported as `jellybean "github.com/fisherevans/jellybean"`
from `cmd/jellybean/main.go`.

## Local dev

`scripts/jb` is the single entrypoint for running, controlling, and
testing Jellybean locally. It reads secrets from the macOS Keychain
under the `jellybean.*` prefix - this is the only place secrets live in
plaintext at rest, and it keeps them out of shell history, env files,
and chat transcripts. Always prefer `jb` over invoking `go run` or
setting env vars by hand.

```
./scripts/jb help              # full subcommand reference
./scripts/jb status            # is daemon up, is /api/health green
./scripts/jb start             # build (if stale) + launch as background daemon
./scripts/jb restart           # pick up code changes
./scripts/jb stop              # SIGTERM, SIGKILL fallback after 15s
./scripts/jb logs [-f]         # last 100 lines, or follow
./scripts/jb dev               # foreground go run for fast iteration
./scripts/jb env               # what env would be passed (secrets redacted)
./scripts/jb keychain {set,get,rm,list}
```

### Authenticated API testing without typing the password

```
./scripts/jb auth-setup        # one-time: stores JELLYFIN_USERNAME + JELLYFIN_PASSWORD in keychain
./scripts/jb auth              # mints a session cookie -> .run/cookie.txt (mode 600)
./scripts/jb api METHOD PATH [body-json]
```

Use `jb api` for any authenticated check (`/api/admin/*`, `/api/auth/me`).
The cookie expires after the normal 7-day idle session; re-running `jb
auth` mints a fresh one. Never run `jb keychain get JELLYFIN_PASSWORD`
or any command that would put a secret into chat output.

### Port and mode

The daemon binds to whatever `JELLYBEAN_PORT` is set to (keychain) or
`8080` by default. Other ports may be in use on this dev machine; check
`./scripts/jb status` for the resolved port. `JB_MODE=docker ./scripts/jb start`
runs the same verbs against `docker-compose.dev.yml` instead of the
local Go binary.

### Required keychain entries

| Key (under `jellybean.*`) | What |
| --- | --- |
| `JELLYFIN_URL` | Jellyfin base URL (LAN IP or tunnel hostname) |
| `JELLYFIN_API_KEY` | Service-account API key for backend reads |
| `JELLYBEAN_SESSION_SECRET` | HMAC secret for session cookies; auto-generated by `jb setup` |
| `JELLYBEAN_KIDS_KEYS` (optional) | M1 stub: `kidkey=jellyfin_user_id` pairs |
| `JELLYBEAN_PORT` (optional) | Override default 8080 if it's taken |
| `JELLYFIN_USERNAME` / `JELLYFIN_PASSWORD` (optional) | Used only by `jb auth` for the test login flow |

The full long-form runbook is in [`docs/dev-setup.md`](docs/dev-setup.md);
day-to-day work should not need to consult it.

## Conventions

- Go module layout per the user-global CLAUDE.md (`cmd/<name>/`,
  `internal/<domain>/`).
- Tests adjacent to code, same package directory. Table-driven tests per the
  user-global format.
- Web apps: TypeScript + React + Vite, embedded into the Go binary via
  `embed.FS`. Static assets served at `/` and `/kids`.
- SQLite driver: `modernc.org/sqlite` (pure Go, no cgo). Pairs with the
  default static base image and avoids cgo-related portability headaches
  across architectures.
- Logging: `github.com/rs/zerolog`, structured.
- HTTP routing: `github.com/gorilla/mux`. Stdlib `http.ServeMux` is fine for
  trivial cases, but Gorilla is the default for the main router so route
  definitions stay readable as the surface grows.
- Runtime base image: `gcr.io/distroless/static-debian12` is the default
  for size + attack surface, but it is not a hard requirement. Swap to a
  debuggable base (e.g. `alpine`) temporarily if you need to shell into
  the container. Don't take dependencies that lock us to one or the other.
- No state-management library on the web side until proven necessary
  (no Redux, no Zustand for v1).
- Migration files live in `internal/db/migrations/` (they need to be there
  so the `internal/db` package can embed them via `go:embed`). Naming:
  `NNNN_short_description.sql`. Numbers are sequential, not timestamped.

## Jellyfin quirks worth remembering

These are non-obvious behaviors caught during integration and now baked
into the code; flagged here so future sessions don't waste time
re-discovering them.

- **`AuthenticateByName` returns 400 (not 401) for bad credentials** in
  some configurations, with body `"Error processing request."`. The
  client maps that to `ErrUnauthorized` so handlers stay clean. See
  `internal/jellyfin/auth.go`.
- **`Authorization` header must include `Device` and `DeviceId`** even
  on the unauthenticated `AuthenticateByName` flow. Some Jellyfin
  configurations reject the request silently otherwise. The default
  identity is `Device="Jellybean Server" DeviceId="jellybean-server"`.
  Kid-side handlers extract the `X-Jellybean-DeviceId` header and stamp
  it on the request context via `jellyfin.WithDeviceID`; downstream
  Jellyfin calls then pick up the per-device id automatically (Device
  flips to "Jellybean Kids"). Use `kidsRequestContext(r)` in any new
  kids handler that touches Jellyfin so the convention stays consistent.
  See `authHeader` + `WithDeviceID` in `internal/jellyfin/client.go`.
- **Tag writes can corrupt items.** Documented Jellyfin issue. We never
  treat tags as canonical state; SQLite is the source of truth.

## Hard rules (do not break)

- **Min Jellyfin version is 10.10.** Pre-10.9 has a metadata-deletion bug we
  cannot work around. Server refuses to start against older versions.
- **`JELLYBEAN_JELLYFIN_TAG_MIRROR` defaults to false** and must stay false
  in dev. Never enable it in dev configs, dev docker overlays, or test code
  paths that hit a real Jellyfin. The user's production library is the dev
  data source.
- **Curation state lives in Jellybean's SQLite.** Jellyfin tags are an
  optional derived export. Never query Jellyfin tags as if they were
  authoritative.
- **Sessions don't store Jellyfin user tokens.** They store the user ID
  only. All backend Jellyfin calls go through the service-account
  `JELLYFIN_API_KEY`.
- **Don't add a Roku codepath.** Roku is intentionally deferred (M-something
  beyond v1). The codebase should not pretend to support it until that
  decision is revisited.

## Things to verify before recommending a change

- Cross-reference your idea against the "Decision" blocks in
  `docs/original-product-idea.md`. Many alternatives have been explicitly
  rejected with reasoning. If you are about to suggest one of them, re-read
  the rejection first.
- If you are about to introduce a new dependency, check whether the stdlib
  or an existing dependency already covers it. Match the stack defaults
  in the user-global CLAUDE.md.
- If you are about to write to Jellyfin (any state-changing API call),
  stop and confirm the `JELLYBEAN_JELLYFIN_TAG_MIRROR` flag is honored.

## Useful commands

```bash
# List open work in the current milestone
gh issue list --repo fisherevans/jellybean --milestone "M1: End-to-end skeleton" --state open

# View an issue
gh issue view <N> --repo fisherevans/jellybean

# View all milestones
gh api repos/fisherevans/jellybean/milestones | jq '.[] | {number, title, open_issues, closed_issues}'

# Read Jellyfin's live API spec (pointed at the configured URL)
curl -s "$JELLYFIN_URL/api-docs/openapi.json" | jq '.paths | keys'
```

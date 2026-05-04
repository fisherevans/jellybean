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
- Jellybean is read-only with respect to Jellyfin. We never write tags,
  collections, or any other Jellyfin state. Curation lives in SQLite.

## Where work is tracked

Milestones and tasks live in GitHub, not in this repo.

- Milestones: `gh api repos/fisherevans/jellybean/milestones | jq '.[] | {number, title, state}'`
- Issues for the current milestone:
  `gh issue list --repo fisherevans/jellybean --milestone "M3: Kids client UI" --state open`
- Single issue: `gh issue view <number> --repo fisherevans/jellybean`

Current milestone: **M5: TV deployment**.

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
- **M3: Kids client UI** (closed) - Browse grid mixing movies + series,
  "Continue Watching" with resume, D-pad focus management, playback with
  reporting back to Jellyfin, per-device DeviceId pass-through. 6 issues.
  Plus a post-M3 auth pivot: API-key TVs replaced with a normal Jellyfin
  username/password login screen (see docs/auth-pivot-plan.md). The kid
  client stores a bearer token locally; admin-side kid records are now
  just (jellyfin_user_id -> profile_id) mappings, no passwords or tokens.
- **M4: Caching layer** (closed) - Server-side ETag on GET /api/kids/library
  with 304 round-tripping, IndexedDB-backed client cache with
  stale-while-revalidate, image proxy returning immutable Cache-Control
  for content-addressed posters, orphan-categorization reconciliation
  (manual trigger via POST /api/admin/maintenance/reconcile), and an
  offline fallback that renders cached library + a "can't play offline"
  message when the network drops. 5 issues.
- **M5: TV deployment** (current) - first real-TV target (Tizen or
  Google TV TBD at milestone start), packaging, sideload script,
  on-device validation. Verify M4's IDB cache + navigator.onLine
  behavior on the chosen TV runtime; consider scheduling the
  reconciler instead of leaving it manual-only.
- **M6: Tags, Favorites, and Profile Tag Filters** (defined, not
  started) - global tags (name + description) assigned manually to
  visible items, per-kid favorites, per-profile tag filters
  (`always_visible` / `always_hidden`) that override per-profile
  categorization. Admin-only surface in M6; kid browse rows land in
  M8 and the kid-side heart + override gesture land in M9. Schema +
  resolution rules in [`docs/tags-and-favorites.md`](docs/tags-and-favorites.md).
  6 issues defined.
- **M7: Watch menu (interstitial)** (defined, not started) - new
  pre-playback screen at `/kids/watch/:id`. Always shown for series;
  shown for movies only when there's resume progress. Hero
  composition (poster + title + actions) over a blurred backdrop;
  series get an accordion episode browser below the hero. Back from
  `/play` always lands here (with the video paused), back from
  `/watch` returns to `/library`. 6 issues defined; design in
  `docs/watch-menu.md` (to be written as part of the milestone).
- **M8: Browse UI + Library upgrades** (defined, not started) - the
  kid home becomes a curated row-based Browse screen by default,
  with a top-level tab pill switching to Library (search + filter +
  alphabet jumpscroll). Layouts are reusable entities (named, with
  ordered rows of configurable types: continue_watching, favorites,
  tag, tag_fanout, recently_added, random_unwatched, watch_again).
  Profiles reference a layout. Random / fanout-random rows are
  stable for ~60 minutes (just-in-time regeneration, no recurring
  job). New hidden admin dev menu at `/admin/dev` for force-refresh
  and future tunables. 7 issues defined; design in
  `docs/browse-and-layouts.md` (to be written as part of the
  milestone).
- **M9: Adult override mode** (defined, not started) - a long-press
  UP gesture on a focused content item triggers a PIN-gated modal
  that exposes per-item edit actions (favorite, tags, hide, mark
  watched/unwatched, QR code to deep-link admin). 60s sliding TTL
  on the unlock anchored on menu-close so consecutive edits don't
  re-prompt. Single global 4-digit PIN, bcrypt hash, 60s lockout
  after 3 wrong attempts. New `app_settings` key-value table for
  cross-cutting global settings (PIN, public URL, future M10/M11
  knobs). 6 issues; design in `docs/adult-override.md` (to be
  written as part of the milestone).
- **M-AT: Device-aware transcode negotiation** (defined, not
  started, micro-milestone) - replaces direct Master.m3u8 streaming
  with Jellyfin's PostPlaybackInfo flow + a per-device capability
  profile catalog. Stutter detection on the kid client falls back
  to a lower bitrate on repeated waiting events. Slots in early
  because the M5 hardware (Skyworth Android TV) currently stutters
  on direct-played 4K content. 4 issues; design in
  `docs/device-profiles.md` (to be written as part of the
  milestone).
- **M10: Time limits** (defined, not started) - per-kid daily
  bucket with admin-tunable refill cadence (1h / 4h / 12h / 24h)
  and day-start anchor. Optional per-show daily cap (default
  30min/day) and per-movie daily-starts cap (default 1/day) with
  per-content overrides. TTS audio warnings at 10/5/0 minutes
  remaining. Locked tiles render grayed with a clock icon.
  Override "Grant time" sub-menu wires +5/+10/+15/+30/+60 min,
  "until episode ends," and "until next reset" (per-item /
  per-show / global scopes). Strict mode only in v1; grace mode
  ("finish episode") deferred. 7 issues; design in
  `docs/time-limits.md`.
- **M11: Body breaks** (defined, not started) - opt-in forced
  commercial-style breaks. Accumulator increments on continuous
  /play, decays on pause / menu / browse, resets on cross-content
  swap (next episode of same series does NOT reset). Default 30min
  play -> 5min break. Full-screen overlay with countdown, voice
  announcement (TTS), splash placeholder, full input lockout
  except override gesture. Configurable reasons list and voice
  template per profile. 6 issues; design in `docs/body-breaks.md`.
- **M12: Viewing controls (dim, red-shift, auto-off)** (defined,
  not started) - per-profile CSS-filter ambient effects:
  brightness dim (0-80%), red-shift (sepia + hue rotate to warm),
  and clock-based auto-off with full lockout overlay. Volume cap
  scoped out (too brittle across TV variants). Override sub-menus
  for set-dim / set-red-shift (TTL 15/30/60min/until-reset) and
  sleep timer (15/30/60min). 6 issues; design in
  `docs/viewing-controls.md`.

- **M13: Time-based modes** (defined, not started) - per-profile
  modes that override M6 tag filters / M10 time limits / M12
  viewing controls during a scheduled time window. One mode active
  at a time, alphabetical priority. Hard transitions with TTS +
  theme cross-fade. Theme = named background-color preset for v1
  (default / bedtime / morning / focus). Soft cap of 2 modes per
  profile. 7 issues defined; design in `docs/time-based-modes.md`
  (to be written as part of the milestone).
- **M14: API keys for headless admin access** (defined, not
  started) - bearer-token auth equivalent to admin cookie. Single
  permission level (no scopes). Admin UI for create / name /
  revoke / track last-used + an access log. Replaces the original
  "MCP server for LLM curation" framing - simpler REST + key
  model, can wrap with MCP later if there's demand. 3 issues
  defined; design in `docs/api-keys.md`.
- **M15: Cable TV mode (channels)** (defined, not started) -
  per-profile channels (mix of tag membership + explicit item
  picks). Continuous shuffled playback via SPA-managed queue with
  prefetch. Up Next overlay + Skip button on the M5 player
  transport. Auto-skips locked items. Channel tile is a new M8
  layout-row type. 6 issues defined; design in `docs/channels.md`.
- **M16: Additional TV sources (research spike)** (defined, not
  started) - time-boxed investigation into YouTube / PBS Kids /
  other public sources. No production code; the deliverable is
  `docs/external-sources-research.md` with feasibility verdicts +
  architectural recommendation. 1 issue (the spike itself).
- **M17: Skip intro / outro markers (placeholder)** - read
  Jellyfin `MediaSegments` markers and surface a "Skip Intro" /
  "Skip Credits" button on the player transport. No issues yet;
  will be scoped when M5's player UX settles and the marker
  coverage in the user's library is assessed.

(The original M6 "Optional Jellyfin tag mirror" was scrapped - the local
SQLite store is already the source of truth and there is no benefit to
mirroring it back to Jellyfin's tag system, which has known
write-corruption issues anyway. The slot was reused for the current M6
above.)

Implementation order across all milestones lives in
[`docs/roadmap.md`](docs/roadmap.md). The sequence isn't strictly
M5 -> M6 -> M7; e.g. M-AT slots between M5 and M6 because of
hardware-stutter pain, and M14 slots between M6 and M9 because it's
small and unblocks LLM-assisted tagging. Read the roadmap doc before
picking a milestone to start.

Issues for far-future milestones are scoped at planning time but
intentionally light on implementation detail - they get refined when
their predecessor closes, informed by what we learned.

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
- **Jellybean never writes to Jellyfin.** No tags, no collections, no
  metadata mutations. The only state-changing calls are PlaystateApi
  reports (start / progress / stopped) on behalf of the kid TV, which
  are not metadata writes. If a feature wants to mutate Jellyfin state,
  we surface that decision explicitly before adding it.
- **Curation state lives in Jellybean's SQLite.** This is the only source
  of truth for visibility decisions. Don't read Jellyfin tags as if they
  carried Jellybean state.
- **Sessions don't store Jellyfin user tokens.** They store the user ID
  only. Admin-side Jellyfin calls go through the service-account
  `JELLYFIN_API_KEY`; kid-side calls use the kid's bearer token (passed
  through from the TV via /api/kids/auth/login).
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
- If you are about to write to Jellyfin (any state-changing API call
  beyond the existing PlaystateApi reports), stop and confirm with the
  user. Jellybean is read-only with respect to Jellyfin metadata.

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

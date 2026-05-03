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
  `gh issue list --repo fisherevans/jellybean --milestone "M1: End-to-end skeleton" --state open`
- Single issue: `gh issue view <number> --repo fisherevans/jellybean`

Current milestone: **M1: End-to-end skeleton**.

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

- **M1: End-to-end skeleton** (current) - Go server scaffold, Jellyfin client,
  parent auth via Jellyfin, parent + kids streaming proof, Docker image,
  CI publishing, dev runbook. 8 issues.
- **M2: Curation data model and parent web app** - SQLite curation schema,
  categorization API, auto-categorization heuristics, real curation UI
  (initial sweep, triage, recent activity, search), kid profile management.
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

## Repo layout

The repo is mid-bootstrap; this section is filled in as M1 lands. Expected
shape based on M1 issues:

```
cmd/jellybean/          # Go entrypoint
internal/config/        # env var loading
internal/server/        # HTTP server, routes, middleware
internal/jellyfin/      # Jellyfin API client
internal/auth/          # session handling, login, middleware (M1.3)
internal/db/            # SQLite connection + migrations
migrations/             # SQL migration files, sequentially numbered
web/admin/              # Vite + React parent curation app
web/kids/               # Vite + React kids streaming client
examples/docker-compose.yml
docker-compose.dev.yml
Dockerfile
.github/workflows/build.yml
docs/                   # design docs and runbooks
```

## Conventions

- Go module layout per the user-global CLAUDE.md (`cmd/<name>/`,
  `internal/<domain>/`).
- Tests adjacent to code, same package directory. Table-driven tests per the
  user-global format.
- Web apps: TypeScript + React + Vite, embedded into the Go binary via
  `embed.FS`. Static assets served at `/` and `/kids`.
- SQLite driver: `modernc.org/sqlite` (pure Go, no cgo) - this matters
  because the runtime image is `gcr.io/distroless/static-debian12` and cgo
  would force a glibc base.
- Logging: `log/slog`, structured.
- HTTP routing: stdlib `http.ServeMux` (Go 1.22+ pattern matching). Don't
  pull in chi/gorilla.
- No state-management library on the web side until proven necessary
  (no Redux, no Zustand for v1).
- Migration files live in `migrations/` with the format
  `NNNN_short_description.sql`. Numbers are sequential, not timestamped.

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

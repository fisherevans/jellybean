# Original Product Idea

This is the founding vision doc for Jellybean. It captures the problem, the
shape of the product, and the early decisions made during the initial
conversation. Implementation details are deliberately light - this is a "what
and why," not a "how." Open questions are listed at the bottom; they should be
resolved before serious build work starts.

> **Post-M3 amendment (2026-05):** the "Jellyfin tag mirror" feature
> referenced throughout this doc was scrapped. The local SQLite store is
> the source of truth for curation; mirroring decisions back to Jellyfin
> as tags has no real benefit (the parent never browses Jellyfin's UI to
> see Jellybean state) and Jellyfin's tag-write code has known
> corruption issues. Jellybean is now strictly read-only with respect to
> Jellyfin metadata. Where this doc says "tag mirror," treat it as
> historical context, not an active plan.

## Problem

Jellyfin and Plex are great media servers but their first-party clients are not
good for two related use cases:

1. **Kid-safe browsing.** A four year old should be able to pick a show with
   up/down/left/right and one big button. Disney+ nails this. Plex and Jellyfin
   do not - their UIs surface menus, libraries, settings, and the entire adult
   catalog mixed in with the kids content. Curating via collections or tags
   inside Jellyfin/Plex is possible but the management UI is generic and
   tedious enough that it rarely stays in sync.
2. **Performance on large libraries.** Both clients feel sluggish on a large
   personal library, even on capable hardware. The catalog rarely changes;
   there is a lot of headroom for aggressive caching that the official clients
   do not exploit.

Jellybean is a focused replacement for these two problems. It is not a general
media client.

## Goals

- A streaming client built for kids using TV remotes - flat navigation, large
  hit targets, immediate playback.
- A curation experience for the parent that is fast and pleasant enough to
  actually use, including for the painful initial sweep of an existing library.
- Heavy local caching so browsing feels instant even on a slow TV app
  sandbox.
- Multi-profile support so each kid sees their own "recently watched" and
  (eventually) their own age-appropriate slice of content.

## Non-goals

- Replacing Jellyfin. Jellyfin remains the source of truth for media,
  metadata, transcoding, and playback.
- Supporting Plex. Jellyfin only for v1 - its API is open and fully
  documented, which materially lowers integration cost. Plex Pass is available
  if we revisit this later, but is not a v1 driver.
- A general-purpose media client with library management, server admin, live
  TV, etc.
- A mobile-first app. Phones and tablets are not target platforms in v1. A
  browser build is fine as a development and testing surface, not a shipped
  product.

## The two apps

### 1. Streaming client (primary)

Installed on TV devices. Used by the kids.

**Target platforms (devices we want to support eventually):** Roku, Samsung
Tizen, LG webOS, Google TV / Android TV.

**Implementation order, v1:** Samsung Tizen first. Tizen + webOS + Google TV
can share an HTML/JS codebase so once Tizen works, the other two are mostly
packaging/shims. Roku is a separate codebase (BrightScript / SceneGraph) and
gets ported only if and when the Tizen UX is locked in and the port is worth
the effort. See Technical considerations for why no shared-codebase path to
Roku exists. Web build doubles as the local development target.

**UX requirements:**

- Profile picker on launch. Big avatar tiles, single-click selection. No
  passwords, no PINs.
- Flat browse: directional pad navigates a grid of shows; OK button plays.
  Avoid nested menus where possible.
- Recently watched and "keep watching" surface near the top.
- Aggressive local caching of metadata and artwork. Assume the catalog rarely
  changes; treat the cached view as authoritative on launch and refresh in
  the background. Storage limits vary by platform (Roku is the tightest); the
  cache strategy needs to handle eviction and partial hydration.

**Playback:**

- Stream directly from Jellyfin using Jellyfin's existing transcoding /
  direct-play negotiation. Jellybean does not re-implement streaming.
- Auth against Jellyfin using a Jellyfin user account per kid (so Jellyfin's
  own "recently watched" tracking does the work for us).

### 2. Curation web app (secondary)

A web UI for the parent. Lets the parent decide what is kid-safe and what is
not, fast.

**Curation model:**

- Every item in the library is in one of three states: kid-safe, not kid-safe,
  uncategorized.
- Source of truth is Jellybean's own database, keyed by Jellyfin item ID. We
  do *not* trust Jellyfin tags as the persistence layer (see Technical
  considerations - tag writes have known durability and corruption issues).
- Optional one-way mirror to a reserved Jellyfin tag (e.g. `jellybean:kids`)
  for visibility inside Jellyfin's own UI, treated as a derived view that can
  be regenerated from the database at any time.
- The streaming client asks Jellybean for the filtered list, not Jellyfin.

**Core flows:**

- **Initial sweep.** For an existing large library, present items grouped by
  the system's *guess* (kid / not-kid) rather than alphabetically. Reading
  through "things we think are adult" looking for outliers is much faster
  than pattern-matching back and forth. Provide bulk-select + categorize.
- **Tinder-style triage.** Swipe / left-right on a single item at a time for
  the cases where bulk doesn't work and the parent wants to chew through
  uncategorized items quickly.
- **Recent activity.** A list of recently-categorized items so the parent
  can spot and fix mistakes shortly after making them. Requires that we
  capture our own categorization timestamps, since Jellyfin tag history is
  not reliable for this.
- **Search / re-categorize.** Find a specific title and change its
  classification.

**Auto-categorization (assist, not decide):**

- Uses Jellyfin's existing metadata: content rating (G, PG, TV-Y, TV-G, etc.),
  genre, studio. No external API calls in v1 - see Technical considerations
  for why Common Sense Media and similar are not realistic options.
- Outputs a *suggestion* with a confidence score, not a decision. The parent
  confirms in the curation UI.
- Items the heuristics flag with high confidence as kid-safe or not-kid-safe
  get pre-grouped accordingly in the initial sweep view; ambiguous items
  land in the "needs review" bucket.

## Architecture

### Topology

Jellybean ships as a Docker container that runs alongside Jellyfin in the same
Compose stack. It is *not* a proxy in front of Jellyfin.

```
+-------------------+         +-------------------+
|   Kids client     |  --->   |     Jellyfin      |  (auth, stream, transcode)
|   (TV app)        |         |                   |
+-------------------+         +-------------------+
        |                              ^
        | "what's allowed?"            | catalog reads, optional tag mirror
        v                              |
+-------------------+                  |
|     Jellybean     | -----------------+
|   (web + API +    |
|    SQLite)        |
+-------------------+
        ^
        | curation UI
        |
   Parent's browser
```

The kids client asks Jellybean for the filtered list of items, then streams
the matching IDs directly from Jellyfin. Jellybean reads Jellyfin's catalog
and metadata to know what items exist, stores categorization state in its own
SQLite database, and optionally writes a derived `jellybean:kids` tag back to
Jellyfin for visibility.

**Why not proxy Jellyfin?** Putting Jellybean in the request path means
re-implementing or pass-through-handling auth, sessions, websockets, and
streaming negotiation. The sibling pattern keeps Jellybean a thin service
focused on one job: serving a filtered, kid-safe view of the catalog. The
proxy approach is on the table as an alternative if we hit a case it solves
better, but sibling is the default.

### Where state lives

- **Curation state (source of truth):** Jellybean's SQLite database. Schema
  is roughly `(jellyfin_item_id, category, set_at, set_by, source)` where
  `source` distinguishes manual vs auto-suggested. Keyed by Jellyfin's stable
  item GUID so library rescans do not orphan rows. Tags, favorites, and
  per-profile tag filters extend the same SQLite store; see
  [`docs/tags-and-favorites.md`](tags-and-favorites.md) for schema +
  resolution rules.
- **Jellyfin tag mirror (derived):** scrapped. The local SQLite store is
  authoritative; Jellyfin tags have known write-corruption issues and
  there is no benefit to mirroring back. Originally M6 in the milestone
  plan; replaced by the M6 (Tags + Favorites) work above.
- **Profiles:** Jellyfin users, one per kid. Profile switching in the
  streaming client is a Jellyfin auth swap.
- **Parent web UI auth:** Jellyfin user login. The parent signs in to the
  curation web app with their Jellyfin admin credentials; Jellybean
  validates against Jellyfin's auth endpoint and issues a session token.
  No standing passwords to manage in Jellybean itself. See Technical
  considerations for the full flow.

### Caching

The streaming client should cache:

- Library / catalog snapshots (filtered to kid-safe).
- Item metadata.
- Artwork (posters, thumbnails).

Strategy: load from cache immediately on launch, render UI, then refresh in
the background. Invalidation can be coarse - a content version / etag from
Jellybean covering the kid-safe set is probably enough, since the catalog
changes rarely.

## Tech choices

- **Server (Jellybean container):** Go. HTTP API, talks to Jellyfin's REST
  API, serves the management web app, persists local state in SQLite.
- **Curation web app:** TypeScript + React + Vite. Served by the Go
  container.
- **Tizen / webOS / Google TV client:** TypeScript + React + Vite. Plain
  HTML/JS app, packaged per platform (.wgt for Tizen, .ipk for webOS, APK
  for Google TV). Same build, per-platform manifests and shims. Lightning JS
  considered and rejected for v1 - see Technical considerations.
- **Roku client (later, if):** BrightScript / SceneGraph. Separate codebase.
  No realistic path to share code with the web client.

## Technical considerations

This section captures the research and trade-offs behind the choices above.
It is intentionally more detailed than the rest of the doc - these are the
decisions most likely to bite us if we get them wrong.

### Cross-platform TV reality

The market is split into two camps and there is no bridge between them:

- **Web-runtime TVs:** Samsung Tizen, LG webOS, Google TV / Android TV (via
  WebView), Fire TV, and most newer "smart" TV OSes all run HTML5/JS apps.
  A plain React build runs on all of them. Packaging differs per platform
  (.wgt for Tizen, .ipk for webOS, APK shell for Android TV) but the runtime
  code is shared.
- **Roku:** native BrightScript / SceneGraph. No web runtime. No JS engine.
  No production-quality JS-to-BrightScript transpiler. The notable attempts
  - Roact, rokuJS, brighterscript - are either hobby projects, type-safety
  supersets, or commercial cloud-rendering products (You.i Engine One).
  None get you a "build once, ship to Roku and Tizen" story.

So the practical answer to "is there a platform that builds to both Roku
and Tizen" is no. You.i Engine One is the closest thing, but it is a paid
commercial product with a render-in-the-cloud architecture - not a fit here.

For the web-runtime TVs we have two reasonable choices:

| Option | Pros | Cons |
| --- | --- | --- |
| Plain React + Vite | Familiar stack, fast iteration, easy to debug, decent perf on modern TVs | DOM-based UI can lag on older or low-end TVs, especially Tizen models pre-2020 |
| Lightning JS (Comcast/Metrological) | WebGL-rendered 60fps UI, designed for low-end TV silicon, used in production by Comcast, Plex, etc. | New framework to learn, no JSX/React, smaller ecosystem, more code for the same UI |

**Decision:** plain React + Vite for v1. The user's hardware is modern (Tizen,
webOS, Google TV, Roku), aggressive caching addresses the perf concern from a
different angle (no network = no jank), and React keeps iteration speed high
on the curation web app and the kids client at once. If perf turns out to be
unacceptable on real hardware, Lightning JS is the escape hatch and a
component-by-component migration is feasible since we are not deeply coupling
to React idioms.

**Implementation order:** Tizen first because that is the user's primary
target and easiest to iterate (Tizen Studio emulator + sideload to a real
TV). webOS and Google TV are mostly packaging variations after that. Roku
is a separate project, scheduled only after the Tizen UX has stabilized.

### Jellyfin tag durability is bad enough that we cannot trust it

This was the most important finding. Two known problems:

- Tag writes via the API can fail and corrupt the item until rescan. There is
  an open Jellyfin issue (#10724) where POST `/Items/{id}` to update tags
  returns 400 and leaves the item inaccessible.
- Metadata refresh with "Replace all metadata" wipes manually-set tags.
  Routine library rescans can do the same depending on settings.

This makes Jellyfin tags a poor source of truth for anything important. Since
Jellybean is the source of truth for "is this content kid-safe," we cannot
let a Jellyfin metadata refresh quietly delete that decision.

**Decision:** Jellybean's SQLite is the source of truth, keyed by Jellyfin
item ID. Tags in Jellyfin are an optional one-way export - they exist for
the parent's convenience inside the Jellyfin UI, and they can always be
regenerated from the database. The streaming client asks Jellybean, not
Jellyfin, for "what's kid-safe."

**Side benefit:** the SQLite layer was already needed for categorization
timestamps and the recent-activity flow, so this does not add a new component.

### External rating data: Common Sense Media is probably out of reach

Researched data sources for the auto-categorization assist feature:

- **Common Sense Media:** has a real API, but access requires a partnership
  agreement. They explicitly state API keys are granted "upon initiation of
  a partnership agreement." Rate limited to 100 req/min and they require
  pulling and locally caching data, no on-demand requests. For a personal
  project like this, the partnership process is probably a non-starter.
- **TMDB:** content_ratings (TV) and release_dates (movies) endpoints expose
  certifications (G, PG, TV-Y, TV-G, etc.) by country. Free with an API
  key. This is the *same data Jellyfin already pulls* via its TMDB metadata
  provider, so it is available on items in Jellybean's database without an
  external call.
- **IMDb parental guides:** scrape-only, no API, fragile. Not worth
  building on for v1.
- **Jellyfin's own metadata:** content rating, genre, official rating,
  studio, audience tags. Already there. Free.

**Decision for v1:** the auto-categorization assist uses only Jellyfin's
existing metadata. Heuristics on content rating (G, TV-Y, TV-G → kid-safe
suggestion; R, MA → not-kid-safe suggestion; PG, TV-PG → uncertain, don't
suggest) plus genre keywords and studio (Disney, Pixar, Nickelodeon, Cartoon
Network → kid-safe suggestion). Output is a confidence score, not a
decision. The parent confirms in the curation UI. Common Sense Media stays
on the radar as a possible later enrichment if we ever get partnership
access; nothing is built around assuming it will be available.

### Jellybean parent web UI auth

**Decision:** delegate to Jellyfin's user system. The parent signs in to the
curation web app with their existing Jellyfin admin credentials; Jellybean
does not maintain its own user database or password store.

**Flow:**

1. Parent hits the curation web app, sees a login screen.
2. Enters Jellyfin username + password.
3. Jellybean POSTs to Jellyfin's `/Users/AuthenticateByName`.
4. On success, Jellybean checks that the user has admin privileges (or is
   in an explicitly-configured allowlist - see below) and issues its own
   session token (cookie). On failure, Jellybean returns the same error.
5. Subsequent requests use the session token. Token expiry mirrors Jellyfin's
   default; on expiry, the parent re-authenticates.

**Why this is better than a shared password:**

- No new credentials to manage, store, or rotate. Whatever password
  protection is on the Jellyfin admin account is also what protects
  Jellybean.
- No env-var secret that has to live in compose files or secret stores.
- Revocation works for free: change the Jellyfin password, Jellybean is
  locked out too.
- Aligns with how Jellybean already works for the kids client (Jellyfin
  user accounts as the identity layer throughout).

**Two service-account env vars are still required** (these are not user
auth, they are Jellybean's own backend access to Jellyfin):

- `JELLYFIN_URL` - where Jellyfin lives.
- `JELLYFIN_API_KEY` - a long-lived API key for Jellybean to read the
  catalog, fetch metadata, and (when enabled) write the tag mirror. Issued
  once from Jellyfin's admin dashboard.

**Authorization:** v1 restricts the curation web app to Jellyfin users with
the admin role. A `JELLYBEAN_AUTHORIZED_USERS` allowlist env var can be
added later if non-admin users need access.

**Internet exposure:** the curation app is exposed via the same Cloudflare
tunnel pattern as the rest of the *arr stack (subdomain on the personal
domain). Because Jellybean now provides its own auth via Jellyfin, no
Cloudflare Access layer is needed in front of it. Cloudflare passes
through; Jellybean handles auth. This matches the existing pattern of
"only fall back to Cloudflare Access for services that cannot do their
own auth."

### Streaming client auth and profile switching

Each kid is a Jellyfin user. Profile switching in the streaming client means
re-authenticating to Jellyfin under that user. The realistic options for
how the kids client gets credentials onto the TV:

- **Type a password on the TV:** unacceptable. Remote-based password entry
  is exactly the friction we are trying to remove.
- **Long-lived API key per kid user, stored in the streaming client:**
  pre-provisioned by the parent via the curation web app (parent generates
  a key for each kid in Jellyfin or in Jellybean's UI, kids client stores
  the keys keyed by profile). One-time setup, no passwords on TV.
- **Quick Connect:** Jellyfin's pairing code flow. Good for one-time pairing
  but still requires the parent's intervention each time we need to add a
  device. Not the right primitive for "switch between kids on this TV."

**Decision:** API key per kid profile, provisioned via the curation web app
during initial setup. Stored on the TV per profile. Profile switch is
in-memory; no network round trip.

### Caching strategy

Storage budgets and APIs by platform:

- **Tizen:** IndexedDB and the Cache API are available; storage budget is
  generous for sideloaded apps (typically tens to hundreds of MB; more if
  the user grants persistent quota). Service workers are partially
  supported, varies by Tizen version.
- **webOS:** similar to Tizen - IndexedDB, localStorage, Cache API. Service
  worker support has improved in recent webOS versions.
- **Google TV / Android TV:** standard browser APIs in WebView, generally
  the most permissive of the three.
- **Roku:** registry storage is small (32 KB per channel limit), tmp
  filesystem is per-session. Caching strategy will be very different on
  Roku - mostly in-memory with selective persistence.

**Decision (web client):** IndexedDB for catalog snapshots and metadata,
Cache API for artwork. Treat the cache as authoritative on launch (render
immediately), refresh in the background, swap in new data only on visible
diff. Cache invalidation: a single content version etag computed by
Jellybean, covering the kid-safe set. Bumped whenever the curation set
changes or the underlying Jellyfin items are modified.

### Jellyfin version requirements

Jellyfin had a serious bug pre-10.9 where a temporarily unavailable library
during a refresh would cause its metadata to be deleted. We should require
Jellyfin 10.10 or newer and document this clearly. The container should
detect the Jellyfin version on startup and refuse to run if it is too old.

### Cache invalidation against Jellyfin changes

Jellybean needs to know when Jellyfin's catalog changes (new items, removed
items, metadata updates). Options:

- **Polling:** ask Jellyfin's `/Items` for a delta on a schedule (every few
  minutes). Cheap, simple, slightly stale.
- **Webhooks plugin:** Jellyfin supports webhook plugins that can fire on
  library events. Much more responsive but adds an installation requirement.

**Decision for v1:** polling, every 5 minutes. Stale-by-five-minutes is
fine for a curation tool. Webhook plugin is a later optimization.

### Distribution and sideloading

Tizen and webOS both support sideloading for development without going
through the official store. This is the dev path - we do not need to ship
through Samsung Seller Office or LG Seller Lounge to use the app on our
own TVs. Store submission is a deliberate later step if we want to share
the app beyond personal use. Worth flagging that store submission for
either platform is non-trivial (testing requirements, content review),
but we do not have to take that on to ship the personal version.

### Implementation sequencing recommendation

The dependency graph suggests this order:

1. **Jellybean container + curation web app.** Without curation data, the
   kids client has nothing to filter. This is the gating dependency.
2. **Tizen kids client.** Easiest target to iterate on, primary user
   priority.
3. **webOS and Google TV ports.** Mostly packaging on top of the Tizen build.
4. **Roku port (maybe).** Only if/when the web client UX is locked in and
   the Roku rebuild feels worth the effort. Treat this as a separate
   project, not part of v1.

## Development and deployment

The dev experience is a first-class concern, not an afterthought. Iteration
speed compounds across the whole project, and the shape of the deployment
target affects design choices. This section captures how we develop and how
we ship.

### Deployment target

Production lives in the existing home-server Docker Compose stack alongside
Jellyfin and the *arr stack (Sonarr, Radarr, Prowlarr, etc.) on a Synology
NAS. Jellyfin is already exposed to the public internet via a Cloudflare
tunnel.

Jellybean joins that stack as one new service:

```
docker-compose.yml (existing)
+-- jellyfin              (already there)
+-- sonarr / radarr / ... (already there)
+-- jellybean             (new) -> talks to jellyfin over the compose network
+-- cloudflared           (already there) -> routes public traffic
```

**Network exposure decisions:**

- **Jellybean curation web app:** exposed via Cloudflare tunnel as a
  subdomain on the personal domain (e.g. `jellybean.yourdomain.tld`),
  matching the existing pattern for the *arr stack. Auth is handled by
  Jellybean itself via Jellyfin user login, so no Cloudflare Access layer
  in front (Cloudflare Access email OTP is the fallback for services that
  cannot do their own auth, and Jellybean can).
- **Jellybean kids API:** also via the tunnel, since the streaming client
  needs to reach it from any TV in the house, and conceivably from outside
  the home (kid using the app at grandma's house). Auth is handled by the
  per-profile Jellyfin API keys that the kids client stores locally.
- **Direct Jellyfin streaming:** the kids client streams from Jellyfin's
  existing public URL, unchanged.

**Synology container constraints:**

- Synology DSM's Container Manager runs Compose v2. Standard Docker semantics.
- Architecture matters: most Synology + models are x86_64, some lower-end
  ones are ARM. Build multi-arch images from the start (`docker buildx
  build --platform linux/amd64,linux/arm64`) so we are not boxed in.
- SQLite database lives on a named Docker volume so it survives container
  restarts and image upgrades. Document the volume in the compose example.

### Local dev architecture

The goal is "edit code, see result, no babysitting." The architecture choice
that makes this work:

**Point local dev at the real (production) Jellyfin in read-mostly mode.**

- Reading from the real Jellyfin gives you the real catalog, real metadata,
  real artwork, real library size. No fixtures to maintain.
- Writes go to local SQLite, not Jellyfin. Safe.
- The only Jellyfin write Jellybean ever performs is the optional tag mirror,
  which is **off by default** and gated behind a config flag
  (`JELLYBEAN_JELLYFIN_TAG_MIRROR=enabled`). Dev never sets this. Production
  may or may not, depending on whether the parent wants to see jellybean
  tags in Jellyfin's UI.
- Where Jellyfin lives from the dev machine's perspective is just an env
  var: `JELLYFIN_URL=http://192.168.1.x:8096` on the home network,
  `JELLYFIN_URL=https://jellyfin.yourdomain.tld` when developing remotely.
  Same code, same auth flow.

**Why not a dev Jellyfin instance?** Because keeping a representative test
library in sync with reality is busywork, and the curation features are
fundamentally about working with a real-world catalog. Spin up a dev
Jellyfin only if we hit a case where mutating production-Jellyfin metadata
is unavoidable for a feature, which is not in the v1 scope.

### Per-component dev loops

**Jellybean server (Go):**

- `go run ./cmd/jellybean` against `JELLYFIN_URL` pointing at production
  Jellyfin.
- SQLite at `./dev.db` (gitignored).
- Reload on file change via [air](https://github.com/cosmtrek/air) or
  similar.

**Curation web app (React + Vite):**

- `npm run dev` -> Vite dev server with HMR on `localhost:5173`.
- Proxies API calls to the local Go server on `localhost:8080`.
- Browser is the iteration surface; full keyboard + mouse, fastest possible
  feedback.

**Kids client (React + Vite, Tizen target):**

- 95% of work happens in the browser via `npm run dev:client`. A "remote
  control mode" maps keyboard arrow keys to D-pad input, Enter to OK, Esc to
  Back. This is enough to iterate on layout, focus management, and
  navigation flow without touching a TV.
- The remaining 5% is real-TV testing: focus quirks, font rendering, video
  playback, perf on actual silicon. Make this a one-command flow:
  `npm run deploy:tizen` should build the .wgt, sideload to the configured
  TV via Tizen Studio CLI (`tizen install -n app.wgt -t <tv-name>`), and
  launch the app.
- TV needs to be in developer mode once, with the dev machine's IP
  whitelisted. Document this setup. Same idea exists for webOS and Google
  TV when those land; Roku has its own dev menu sideload flow.

**Full stack via Docker Compose:**

- A `docker-compose.dev.yml` overlay that builds Jellybean from local source
  and runs the same image against the production Jellyfin URL. Useful for
  validating the full container behavior (multi-arch builds, env handling,
  volume mounts) before pushing.
- Production deploys are just `docker compose pull && docker compose up -d`
  on the Synology, no manual steps.

### Build, image, and release flow

- **CI builds and pushes a multi-arch image to a registry** on every commit
  to main (GitHub Container Registry is the obvious choice if the repo
  lives on GitHub).
- **Synology pulls from the registry**, restarts the container. Container
  Manager can be configured to auto-pull on a schedule, or this can be
  triggered manually.
- **No Synology-side builds.** Building Go binaries on a NAS is slow and
  brittle. CI is the build environment.
- **Tagging:** `latest` for the current main, `vX.Y.Z` for releases, `dev`
  for branches if needed.

### Iterating with Claude

A few things help when working with Claude on this:

- The repo contains a `CLAUDE.md` at the root with the user's communication
  preferences, tech stack defaults, and any conventions specific to this
  project. Update it as conventions emerge - especially anything about
  Jellyfin API quirks, Tizen sideload steps, or the dev-vs-prod env var
  story.
- Prefer reading the live Jellyfin API to check schemas over guessing from
  outdated documentation. Jellyfin's OpenAPI spec is exposed at
  `/api-docs/openapi.json` on any running instance.
- A `docs/` folder for design notes (this doc, ADRs as we make them, the
  Tizen setup runbook). Keep it small and current, not exhaustive.

## Open questions

Resolved during research are folded into Technical considerations. What
remains:

- **Per-kid content slicing.** Profiles are in scope for "recently watched"
  via Jellyfin user separation. Is per-kid *content filtering* (older kid
  sees more than younger kid) v1, or do all kid profiles share one
  kid-safe set?
- **Tinder-style triage UX details.** Mobile-style swipe on a desktop web
  app is awkward; left-arrow / right-arrow keyboard shortcuts are probably
  the right input. Confirm before building.
- **Auto-categorization confidence display.** Do we show the parent the
  reasoning ("rated TV-Y, genre Animation") or just the suggestion? Probably
  the reasoning, but worth deciding how compactly.
- **Offline / downloads.** Out of scope for v1 unless contradicted.
- **Parental controls beyond curation.** Time limits, schedules, watch
  caps - not in scope for v1 unless contradicted.
- **Initial setup flow.** First-run wizard to point Jellybean at Jellyfin,
  generate API keys, walk through the initial library sweep. Worth a
  separate design pass once the core data flow is built.

## Risks

- **Tizen perf on older hardware.** Plain React is the v1 choice over
  Lightning JS. If perf on real TVs is bad, the fallback is a per-component
  migration to Lightning, which is real work. Mitigation: test on the
  oldest Tizen device in the house early, before the UI is heavily built
  out.
- **Jellyfin upgrades breaking the API.** Jellybean depends on Jellyfin's
  HTTP API surface. Jellyfin is generally stable but not contractually so.
  Mitigation: pin a minimum Jellyfin version, smoke-test against the latest
  stable in CI, version-gate at container startup.
- **Auto-categorization is weaker than hoped.** Without Common Sense Media
  data, the assist relies entirely on metadata heuristics. Some content
  (e.g. PG-13 animated, anime) will be hard to classify automatically and
  will fall back to manual review. The product still works - the assist
  is an accelerator, not a requirement - but the initial sweep takes
  longer than it could.
- **Roku effort if/when we get there.** BrightScript is a separate codebase
  and a separate skill set. The choice to defer Roku to "fast-follow port,
  maybe" is correct, but it does mean Roku users get nothing in v1.
- **TV app store submission.** Tizen and webOS submission processes are
  non-trivial. Sideloading covers the personal-use case fully; store
  submission is a deliberate later decision.
- **Dev pointing at production Jellyfin.** The convenience comes with the
  risk that a bug in the tag-mirror code could mutate real metadata.
  Mitigation: tag mirror is opt-in and off by default; dev never sets the
  flag; integration tests exercise the mirror against a throwaway Jellyfin
  in CI before the code path is allowed near production.

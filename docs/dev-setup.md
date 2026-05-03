# Local dev setup

Goal: clean checkout to "running Jellybean locally pointed at the real
Jellyfin" in a few minutes. The architecture is documented in
[`original-product-idea.md`](./original-product-idea.md) - this runbook is
the how, not the why.

## Prerequisites

- Go 1.25+ (`go version`)
- Node 20+ (`node --version`)
- Docker (only needed for the Compose smoke test in the last section)
- Access to a running Jellyfin 10.10+

## Environment variables

| Var | Required | Default | What it does |
| --- | --- | --- | --- |
| `JELLYFIN_URL` | yes | - | Base URL of your Jellyfin server (e.g. `http://192.168.1.10:8096` or `https://jellyfin.yourdomain.tld`) |
| `JELLYFIN_API_KEY` | yes | - | Service-account API key Jellybean uses for backend reads |
| `JELLYBEAN_SESSION_SECRET` | yes | - | Any high-entropy string. Rotate it to invalidate every active session at once. |
| `JELLYBEAN_PORT` | no | `8080` | Port the Go server listens on |
| `JELLYBEAN_DB_PATH` | no | `./jellybean.db` | SQLite path. In Docker this is `/var/lib/jellybean/jellybean.db`. |
| `JELLYBEAN_ENV` | no | `production` | Set to `dev` for human-readable logs and `Secure: false` cookies |
| `JELLYBEAN_JELLYFIN_TAG_MIRROR` | no | `false` | **Keep `false` in dev.** See note below. |
| `JELLYBEAN_KIDS_KEYS` | no | empty | M1 stub for kid profile mapping: `kidkey1=jellyfin_user_id_1,kidkey2=jellyfin_user_id_2`. Replaced by real key issuance in M2. |

### Generating the Jellyfin API key

1. Open Jellyfin admin -> Dashboard -> API Keys.
2. Click "+" to mint a new key. Name it "Jellybean" so you can tell it apart later.
3. Copy the key into `JELLYFIN_API_KEY`.

This is a service-account key, not a per-user token. Jellybean uses it for
backend reads (catalog, metadata) and for signing M1 stream URLs. It does
NOT need to belong to a specific Jellyfin user.

### `JELLYBEAN_URL` for local vs remote dev

Both work, just match where your dev machine is:

- **At home (LAN):** `JELLYFIN_URL=http://192.168.x.y:8096`
- **Anywhere via Cloudflare tunnel:** `JELLYFIN_URL=https://jellyfin.yourdomain.tld`

Same code path; it's purely a config knob.

### Tag mirror MUST stay off in dev

`JELLYBEAN_JELLYFIN_TAG_MIRROR=false` is the default and must stay `false`
locally. Reason: dev points at your real Jellyfin (no fixtures), and a bug
in the mirror code could write garbage tags or trip Jellyfin's known tag-
write corruption bug (see Technical considerations in
`original-product-idea.md`). The mirror only flips on in production once
M6 lands and the mirror code has been integration-tested.

## Running locally

Three things to start. They each pick up env vars from your shell, so
either export them or use direnv / a `.env` file with your loader of
choice.

### Go server

From the repo root:

```bash
JELLYBEAN_ENV=dev \
JELLYFIN_URL=http://192.168.1.10:8096 \
JELLYFIN_API_KEY=... \
JELLYBEAN_SESSION_SECRET=$(openssl rand -hex 32) \
go run ./cmd/jellybean
```

Listens on `:8080`. Logs in human-readable form (`zerolog.ConsoleWriter`)
when `JELLYBEAN_ENV=dev`.

`go run` works without a prior web build. The Go binary embeds the dist
dirs from `web/admin/dist` and `web/kids/dist`, but if those are empty
the server returns a "frontend not built" 503 from `/`. That's fine for
backend-only work; serve the frontend with `npm run dev` instead.

### Parent admin web app

```bash
cd web/admin
npm install
npm run dev
```

Vite serves `http://localhost:5173`. The dev server proxies `/api/*` to
`http://localhost:8080`, so the Go server must be running for login to
work.

### Kids client web app

```bash
cd web/kids
npm install
npm run dev
```

Vite serves `http://localhost:5174` with the `/kids` base path. Visit
`http://localhost:5174/kids/setup?key=KIDKEY&item=ITEMID` to seed a kid
key and jump straight into playback. `KIDKEY` must match a key in your
`JELLYBEAN_KIDS_KEYS` env var.

## Day-to-day loop

For backend-only changes:

```bash
go test ./...
go run ./cmd/jellybean
```

For frontend changes: keep `npm run dev` running in `web/admin` (or
`web/kids`) and edit; HMR is instantaneous.

For end-to-end embed validation: build the web apps, then start the Go
server. The dist dirs get baked into the binary on the next `go build`.

```bash
(cd web/admin && npm run build)
(cd web/kids && npm run build)
go build ./cmd/jellybean
./jellybean
```

Open `http://localhost:8080` for the admin app, `/kids/setup` for the
kids client.

## Full stack via Docker Compose (smoke test)

This validates the Dockerfile end-to-end. Slower than `go run`, so use it
only when you change the Dockerfile or want to mirror production locally.

```bash
JELLYFIN_URL=https://jellyfin.yourdomain.tld \
JELLYFIN_API_KEY=... \
JELLYBEAN_SESSION_SECRET=$(openssl rand -hex 32) \
docker compose -f docker-compose.dev.yml up --build
```

## Troubleshooting

- **`fatal: load config: missing required environment variables: ...`** -
  check `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `JELLYBEAN_SESSION_SECRET`.
- **`fatal: connect to jellyfin at ...`** - Jellybean can't reach Jellyfin.
  Check the URL is correct from where you're running, and that Jellyfin
  is actually up. From inside the dev shell: `curl -I "$JELLYFIN_URL/System/Info"`.
- **`jellyfin version X.Y.Z is too old; requires >= 10.10`** - upgrade
  Jellyfin. The version gate is enforced because Jellyfin pre-10.9 has a
  metadata-deletion bug that bites curation features later.
- **Login returns 403** - your Jellyfin user isn't an admin. M1 only allows
  admins; broader allowlisting lands later.
- **Login returns 429 forever** - the per-IP rate limit is a fixed window;
  wait 5 minutes. To bypass during dev, restart the Go server (rate limit
  state is in-memory).
- **`<video>` shows a black box** - the file isn't direct-playable in
  the browser. Pick a different item; transcoding negotiation is later.
- **Port conflict on 8080 / 5173 / 5174** - override with `JELLYBEAN_PORT`
  and Vite's `--port` flag.
- **Go workspace error: "directory prefix . does not contain modules ..."**
  - the parent `~/dev/go.work` doesn't include this repo. The local
  `go.work` we ship overrides it; check that file still exists.

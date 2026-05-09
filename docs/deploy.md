# Deploying Jellybean

This is the runbook for standing up a production Jellybean instance
next to an existing Jellyfin server. It assumes a Synology + Docker
host with an *arr stack on a shared `media` Docker network and a
Cloudflare tunnel terminating in front of the box, but the steps
work for any reverse proxy (Nginx, Caddy, Traefik) or no proxy at
all (LAN-only access).

## Prerequisites

| Need | Why | Notes |
| ---- | --- | ----- |
| Jellyfin **>= 10.10** | The kid client relies on metadata that older Jellyfin loses on save (see CLAUDE.md "Hard rules"). | The Jellybean server refuses to start against older Jellyfin builds. |
| A Jellyfin API key | Jellybean's service-account reads (catalog, image proxy). | Jellyfin admin -> Dashboard -> API Keys -> "+". Name it "jellybean" so it's easy to revoke. |
| A high-entropy session secret | Signs the parent admin cookie. | Anything random and >=32 bytes. Rotating it invalidates every active admin session. |
| Docker + Compose v2 | Runtime. | The image is multi-arch (amd64 + arm64); pull works on Synology, Raspberry Pi 4/5, and any cloud host. |

## Image source

The container is published to GHCR on every push to `main`:

- `ghcr.io/fisherevans/jellybean:latest` - rolling tag. Fine for
  personal use; can change underneath you on any commit.
- `ghcr.io/fisherevans/jellybean:sha-<short>` - immutable per-commit
  tag. Use this for production deployments so a `docker compose
  pull` only updates when *you* edit the SHA.

Find the current SHA tags at
<https://github.com/fisherevans/jellybean/pkgs/container/jellybean>.

## Compose file

[`examples/docker-compose.yml`](../examples/docker-compose.yml) is
the production-ready snippet. Drop it into your existing Compose
project (or use it standalone) and adjust:

- `image:` - swap `:latest` for `:sha-<short>` for pinned deploys.
- `networks:` - the file assumes a pre-existing external network
  named `media`. Either match that, or change to your stack's
  network.
- `ports:` - keep when you want LAN access (e.g. casting from a
  laptop browser); remove when Jellybean is reached only via your
  reverse proxy.

## Required env vars

Stored as a `.env` file alongside the Compose project (don't commit
it), or via your host's secrets manager.

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `JELLYFIN_API_KEY` | yes | Jellyfin service-account key. |
| `JELLYBEAN_SESSION_SECRET` | yes | HMAC secret for admin session cookies. |
| `JELLYFIN_URL` | yes (set in compose) | Internal URL Jellybean uses to reach Jellyfin. **The kid TVs and admin web never see this URL** - it's server-side only. |
| `JELLYBEAN_PORT` | no (default `8080`) | Container listen port. **Changing this alone is not enough** - you also need to update the Dockerfile's `EXPOSE`, the compose `ports:` mapping, and the healthcheck command (see "Customizing the listen port" below). |
| `JELLYBEAN_DB_PATH` | no (default `/var/lib/jellybean/jellybean.db`) | SQLite database path inside the container. Persisted via the named volume. |
| `JELLYBEAN_ENV` | no (default `production`) | `dev` enables verbose-friendly defaults. |

## Persistence

The SQLite database carries:

- Curation state (per-profile categorizations, layouts, kids,
  favorites, tags).
- Admin sessions + API key hashes.
- Per-kid time-limit and body-break state.

It is the only thing you need to back up. The volume mounted at
`/var/lib/jellybean` (named `jellybean-data` in the example) is the
file's home; back up the entire volume.

Rotating images is safe - the database file persists across
container restarts and image upgrades. The schema baseline lives at
`internal/db/migrations/0001_baseline.sql`; future migrations are
additive on top.

## First-time bring-up

1. **Generate the API key + session secret.**
   ```bash
   # On the Docker host, where the .env file will live:
   echo "JELLYFIN_API_KEY=<paste-from-jellyfin-admin>" >> .env
   echo "JELLYBEAN_SESSION_SECRET=$(openssl rand -hex 32)" >> .env
   chmod 600 .env
   ```

2. **Bring the service up.**
   ```bash
   docker compose up -d jellybean
   docker compose logs -f jellybean    # confirm it boots
   ```
   The first start runs the schema baseline on a fresh database.
   You should see `db migrations applied` and a `server listening`
   line within a few seconds.

3. **Verify health.**
   ```bash
   curl -fsS http://localhost:8080/api/health   # expect HTTP 200
   docker compose ps jellybean                  # STATUS: healthy
   ```

4. **Sign in.** Visit `http://<host>:8080/` (or your tunnel URL).
   The admin login defaults to Quick Connect when your Jellyfin
   server has it enabled - sign in on the Jellyfin client of your
   choice and enter the 6-digit code. Or click "Use password
   instead" to type your Jellyfin admin credentials directly.
   Jellybean stores no Jellyfin password; it forwards the auth and
   issues its own cookie.

5. **Add the first kid.** Admin -> Kids -> Create. The kid record
   maps a Jellyfin user to a Jellybean profile. The TV signs in as
   that Jellyfin user; Jellybean looks up the profile from there.

## Upgrades

Pinned tags (recommended):

```bash
# 1. Look up the new SHA tag at the GHCR package page.
# 2. Edit examples/docker-compose.yml -> image: ghcr.io/fisherevans/jellybean:sha-<new>
# 3. Pull + restart:
docker compose pull jellybean
docker compose up -d jellybean
docker compose logs -f jellybean   # confirm clean start
```

Rolling latest:

```bash
docker compose pull jellybean && docker compose up -d jellybean
```

The schema is forward-only; you don't need to stop the container to
upgrade. Active admin sessions survive a restart (they're in
SQLite). Active kid bearer tokens are Jellyfin tokens, so they
also survive a Jellybean restart.

## Rollback

Same steps in reverse: edit the SHA tag in the Compose file back to
the previous version, `docker compose pull`, `docker compose up
-d`. Don't downgrade across destructive schema changes - check
`internal/db/migrations/` between the two SHAs first. As of now
(pre-v1) all migrations are squashed into a single baseline, so
rolling back to any tag from the same baseline is safe.

## Reverse proxy notes

The session cookie binds to whatever origin the browser used. That
means:

- **Same origin everywhere** - if you reach Jellybean via
  `https://jellybean.example.com` from both the admin laptop and
  the kid TV, you're fine.
- **Don't share the cookie across Jellyfin's domain.** Sessions are
  scoped to the Jellybean origin; Jellyfin auth is delegated, not
  shared.
- **`Secure` cookies are auto-enabled in production** (`JELLYBEAN_ENV`
  != `dev`). If you front Jellybean with a non-HTTPS proxy, set
  `JELLYBEAN_ENV=dev` to flip the cookie back to non-secure.
  Recommended only for local LAN deploys.

For Cloudflare tunnel: add an ingress rule pointing
`jellybean.yourdomain.tld -> http://jellybean:8080`. Auth is handled
by Jellybean (Jellyfin user login on top of Jellybean's session);
no Cloudflare Access layer is needed.

### `X-Forwarded-*` headers

Jellybean honors `X-Forwarded-For` for rate-limiting (see
`internal/auth/handlers.go` `clientIP`). It currently does NOT consult
`X-Forwarded-Proto` - the `Secure` cookie attribute fires on
`!IsDev()` regardless of how the inbound TLS terminated. That works
correctly behind Cloudflare or any HTTPS-terminating reverse proxy
because `Secure` is just metadata for the browser; the proxy ->
Jellybean leg can be plain HTTP.

If you front Jellybean with a proxy that chains *another* proxy in
front of it, only trust `X-Forwarded-For` from the immediate
proxy - otherwise a client can spoof the rate-limit source IP.

### Customizing the listen port

If 8080 is taken on the host, the simple fix is the compose
`ports: "9999:8080"` mapping (left side is the host, right side is
the container - leave the container side at 8080 and you don't have
to touch anything else).

To actually move the *container* port (rare; only needed when
running multiple Jellybean copies on the same network without port
mappings), edit:

- `JELLYBEAN_PORT` env var
- the compose `ports:` mapping
- the Dockerfile's `EXPOSE` directive (cosmetic but documented)
- the healthcheck command in `examples/docker-compose.yml` if
  the binary's healthcheck reads the port from `JELLYBEAN_PORT`
  (it does today, so the compose healthcheck just works).

### Compose healthcheck duplication

The Dockerfile already declares a `HEALTHCHECK` that runs
`/jellybean healthcheck`. The compose file re-declares the same
healthcheck inline. This is intentional belt-and-braces:
`docker compose ps` reads the compose-level stanza for its STATUS
column, and `depends_on: condition: service_healthy` only honors
compose-level healthchecks on some Compose versions. Keeping both
in sync (they're identical) costs nothing and keeps both surfaces
working.

### Jellyfin's own healthcheck

The compose file has `depends_on: jellyfin: condition:
service_healthy`. That gate only fires when the Jellyfin service
itself declares a healthcheck. The official Jellyfin image ships
with one; if you've inlined a custom Jellyfin spec, make sure it
has one too, or change the dependency to `service_started` (less
strict but always satisfiable).

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `JELLYFIN_URL` errors at startup | Confirm the URL is reachable from inside the Jellybean container: `docker compose exec jellybean wget -qO- $JELLYFIN_URL/System/Info`. If using Docker DNS, the service name (e.g. `jellyfin:8096`) only resolves on a shared user-defined network. |
| `401 admin role required` on login | The Jellyfin user must be an administrator. Promote in Jellyfin admin -> Users. |
| Quick Connect tab missing | Jellyfin admin -> Dashboard -> General -> "Allow Quick Connect" must be on. The Jellybean login probes `/QuickConnect/Enabled` and falls back to password silently. |
| Kid TV sees "user isn't set up as a kid" after a successful Jellyfin login | Add the Jellyfin user to a Jellybean profile in Admin -> Kids. |
| TLS/cookie issues behind a custom proxy | Verify `X-Forwarded-Proto` is forwarded; the secure-cookie default expects HTTPS in production. |

## Related docs

- [`dev-setup.md`](dev-setup.md) - local dev environment (the
  `scripts/jb` keychain workflow).
- [`auth-pivot-plan.md`](auth-pivot-plan.md) - how the kid auth
  model works end to end.
- [`api-keys.md`](api-keys.md) - bearer-token auth for headless
  admin scripts.

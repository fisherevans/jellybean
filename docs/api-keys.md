# API keys (M14)

Bearer-token auth for headless admin access. Use these to point an
LLM at the admin REST API for tag population, write maintenance
scripts that don't need an interactive browser session, or hit
Jellybean from another piece of home automation.

## Auth model

A bearer token is equivalent to the admin cookie. There is one
permission level - any holder of a valid token has the same access
the parent has when logged in via the browser. Scopes were
deliberately scoped out for v1; revisit when there's a real consumer
needing read-only or per-resource access.

## Issuing a key

`/admin/api-keys` (in the admin UI):

1. Type a name describing the consumer (e.g. `tagging-llm`,
   `nightly-recategorize`).
2. Click **Create key**. The plaintext token is shown ONCE; copy it
   immediately. Jellybean only stores the SHA-256 hash, so a lost
   token is unrecoverable - revoke + create a new one if you lose it.

Tokens are formatted `jb_<64 hex>` (~256 bits of entropy). The `jb_`
prefix lets you grep for accidental leaks.

## Using a key

```bash
curl -H "Authorization: Bearer jb_..." \
     https://<jellybean-host>/api/admin/profiles | jq
```

Every `/api/admin/*` endpoint accepts the bearer header. The cookie
path still works on browser sessions in parallel - tokens are an
alternative, not a replacement.

## Lifecycle

- `last_used_at` updates on every successful auth.
- `revoked_at` is set by the **Revoke** button. Revoked keys are
  immediately rejected; the row stays so historical access-log
  entries continue to point at a known name.
- **Delete** drops the row entirely. Access-log entries pointing at
  it survive (key id is set NULL by the FK cascade) so audit history
  isn't lost.

## Access log

Every successful bearer call is recorded:

| field | meaning |
| --- | --- |
| occurred_at | unix timestamp |
| key_id | id of the key used (NULL if the key was later deleted) |
| method | HTTP method |
| path | URL path (no query string - secrets sometimes leak there) |
| status | response status |

The log writes async on a goroutine so the request hot-path stays
unblocked. `/admin/api-keys` shows the most recent 200 entries with
a per-key filter button.

## Security caveats

- **The token IS the credential.** Don't paste it into chat logs,
  GitHub issues, or shared docs. Treat it like an API key (because
  it is one).
- Tokens have no expiry. If a system goes idle for months, the token
  still works - revoke it manually if you're decommissioning a
  consumer.
- Cookie auth still uses the existing 5/5min rate limit; bearer auth
  is uncapped on the assumption that anyone holding a valid token is
  trusted. Add rate-limiting if a consumer turns out to be abusive.
- HTTPS only in production. The dev daemon binds to plain HTTP for
  LAN access; never put the daemon on the internet without a TLS
  terminator.

## What's NOT here (deferred)

- Per-resource scopes (e.g. read-only tag tokens).
- Token rotation (rolling secret with grace window).
- Webhook outbound auth (Jellybean as a sender) - not relevant to
  the headless-consumer use case M14 covers.
- Standalone CLI / wrapper - just curl + jq for now.

If we add scopes later, the natural shape is a `scopes` JSON column
on `api_keys` plus a middleware decorator that checks against the
matched route. Don't pre-build it.

# Auth pivot: from API-key TVs to login-screen clients

This is a redesign of how the kids client authenticates. It replaces the
M1-era "parent provisions an API key per device" model with a normal
username + password login screen, exactly like Jellyfin's own clients.
Drives all subsequent kid-app work (real Tizen / Google TV / mobile app
M5 deployments).

## What was wrong

Today the kids client uses an "API key" the parent generates from the
admin app and pastes into the TV via `/kids/setup?key=...`. The
Jellybean backend stores a per-kid Jellyfin token (minted from the
kid's password at create time) and uses it to attribute playback. This
model was a stopgap from M1 when there was no real client; it leaks in
several ways:

- Parents are entering kid Jellyfin passwords into the **admin** UI to
  mint a token, instead of the kid app prompting on first launch like
  every other media client.
- Every TV needs a paste-the-key step. Clipboard on a TV is awful.
- The backend holds long-lived per-kid tokens. Bigger blast radius
  than is justified by the value.
- The admin form has fields the parent shouldn't be filling in
  (`Jellyfin password`).

## What we want

When the user installs the kid app on a TV / phone / browser:

1. App opens to a **server URL + Jellyfin username + Jellyfin password**
   login screen.
2. App POSTs the credentials to **Jellybean** (not directly to
   Jellyfin). Jellybean forwards to Jellyfin's `AuthenticateByName`,
   gets a token + user id back, looks up which Jellybean profile that
   Jellyfin user is mapped to, and returns
   `{ token, userId, userName, profileId }`.
3. App stores `token + userId` in localStorage (browser) / native
   keychain (Tizen / iOS / Android wrap).
4. App presents the token on every subsequent `/api/kids/*` request
   (e.g. `Authorization: Bearer <token>`). Jellybean uses it for the
   downstream Jellyfin call, so attribution lines up correctly.
5. Sign out clears local storage. Switching kid = sign-out + sign-in,
   same UX as Jellyfin's own clients.

The admin UI's job shrinks to "map Jellyfin users → profiles". No
passwords, no token storage server-side.

## Concrete changes

### Backend

- **DB**: drop columns from `kids`:
  - `api_key_hash`
  - `jellyfin_token`
  Keep: `id`, `name`, `profile_id`, `jellyfin_user_id`, `created_at`.
  Migration `0007_remove_kid_secrets.sql` drops the unused columns.

- **New endpoints** under `/api/kids/auth/`:
  - `POST /api/kids/auth/login` — body
    `{ "username": "...", "password": "..." }`. Calls Jellyfin's
    `AuthenticateByName`. Looks up `kids` row by `jellyfin_user_id` to
    resolve `profile_id`. Returns
    `{ "token", "userId", "userName", "profileId", "profileName" }`.
    400 if the Jellyfin user isn't mapped to a kid in Jellybean.
  - `POST /api/kids/auth/logout` — optional convenience; the app can
    just drop the token client-side.

- **Existing kid endpoints** (`/api/kids/library`, `/items/{id}/stream`,
  `/items/{id}/image`, `/playback/*`): change auth resolver to read a
  Jellyfin token from `Authorization: Bearer <token>` and the
  `jellyfin_user_id` either from a request header or from a
  `/Users/Me`-style verification round-trip. The `kidsContext` struct
  is rebuilt from the bearer token instead of `X-Jellybean-Key`.

- **Admin handlers**:
  - `POST /api/admin/kids` no longer takes a Jellyfin password. Body
    becomes `{ "name", "profileId", "jellyfinUserId" }`. The
    Jellyfin user is picked from a server-side dropdown populated by a
    new `GET /api/admin/jellyfin/users` endpoint that reads from
    Jellyfin's `/Users` API using the service-account key.
  - `POST /api/admin/kids/{id}/regenerate` is removed (no API key to
    regenerate).
  - `PATCH /api/admin/kids/{id}` keeps `{ name, profileId }`.
  - `DELETE /api/admin/kids/{id}` unchanged.

- **Config**: drop `JELLYBEAN_KIDS_KEYS` (env-var stub from M1).

### Admin web

- **Kids page** (`web/admin/src/pages/Kids.tsx`):
  - Modal asks for name + Jellyfin user (dropdown from
    `/api/admin/jellyfin/users`) + profile.
  - Drop Jellyfin username / password fields.
  - Drop the "Regenerate key" + "API key shown once" reveal modal.
  - "View as kid" still works via admin cookie + `?profileId=N`.

- `web/admin/src/KidModal.tsx` — drop password fields, add Jellyfin
  user dropdown.

### Kids client (`web/kids/`)

- **New route** `/kids/login` — server URL (auto-filled from
  `window.location.origin`), username, password, "Sign in" button.
  POSTs to `/api/kids/auth/login`, persists
  `{ token, userId, profileId }` in localStorage.

- **Existing routes**: redirect to `/kids/login` whenever no token is
  in localStorage. The Profiles picker becomes irrelevant (one device =
  one logged-in user); remove it. If the parent wants to switch kids
  on a shared TV, they sign out and sign back in.

- **Drop**:
  - `/kids/setup?key=...` URL flow.
  - `jellybean.kids.profiles` localStorage shape.
  - `X-Jellybean-Key` header on all kids API calls.

- **Add**:
  - `localStorage["jellybean.kids.token"]` (Jellyfin token).
  - `localStorage["jellybean.kids.userId"]` (Jellyfin user id, for
    constructing `/Users/{id}/Items/Resume` URLs in the future).
  - `Authorization: Bearer <token>` on every API call.

### scripts/jb

- Drop `kid-set` / `kid-list` / `kid-rm` / `kapi`. Replace with a
  single `kid-login` that POSTs username+password to
  `/api/kids/auth/login` and stores the resulting token. `kapi NAME`
  still does authenticated requests but signs them with the bearer
  token instead of an API-key header.

### Migration plan

This breaks every existing kid record. Acceptable since this is a
personal home server with one parent and a small set of kids. Steps:

1. Land the backend + admin changes behind a `/api/kids/auth/login`
   endpoint, but keep the old `X-Jellybean-Key` flow working in
   parallel for one release.
2. Land the kid client login screen.
3. Verify with a real Jellyfin login flow on the dev daemon.
4. Drop the old API-key auth path. Migration `0007` cleans the DB.

## Open decisions

- **Token storage on TVs**: localStorage is fine for the browser-based
  dev flow. For Tizen / Google TV / iOS-wrapped builds, the wrapper
  hands tokens to the platform's secure storage (Tizen's Vault,
  Android Keystore, iOS Keychain). Not blocking — same JS-side API,
  the wrapper layer maps it.
- **Jellyfin user list filtering**: when the admin picks a Jellyfin
  user for a new kid, do we hide existing-kid users? Probably yes,
  with a "Showing only unassigned users (toggle)" option for editing.
- **Sessions / token refresh**: Jellyfin tokens don't expire by
  default. If we ever need to refresh, the kid app re-prompts for
  password. Acceptable for v1.
- **Stage 2 (deferred)**: the profile picker on a shared TV. Out of
  scope for this pivot; revisit if it becomes a real ask.

## Effort estimate

Half-day-ish if executed in one sitting:

- Backend: 2-3 hours (new auth endpoint, rewriting `resolveKidsAuth`,
  trimming `kids` schema, scripts/jb).
- Kids client: 1-2 hours (login screen, swap auth header everywhere,
  drop the picker / setup pages).
- Admin: 1 hour (`/Users` dropdown, modal field swap, drop reveal-key
  flow).
- Tests: 1 hour to update + add coverage for the login endpoint.

Suggest landing as one PR / commit chain so the API-key model isn't
half-removed at any point.

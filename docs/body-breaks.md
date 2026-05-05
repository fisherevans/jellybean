# Body breaks (M11)

Opt-in forced-break feature: after `play_minutes` of continuous active
playback, the kid is locked into a `break_minutes` countdown overlay
with a TTS announcement of the picked reason.

## Accumulator semantics

The engine keeps a single accumulator per kid in
`kid_body_break_state.accumulator_seconds`:

- Increments on `/api/kids/playback/progress` reports while
  `isPaused=false`.
- Decays at the same rate when `isPaused=true` (or no progress is
  coming in).
- Resets to zero on a cross-content swap. Definitions:
  - New series id != old series id -> swap.
  - New movie id != old movie id (both seriesId empty) -> swap.
  - Same series, different episode (S1E04 -> S1E05) -> NOT a swap.
  - Same item, restart from beginning -> NOT a swap.
- Hits the threshold and triggers a break when accumulator >=
  `play_minutes * 60` seconds.

The accumulator decays on pause / menu / browse so the kid who pauses
mid-show, gets a snack, and comes back doesn't double-count toward
the next break. There is no separate "break shouldn't trigger when
they just got back" rule - decay handles it.

## Break trigger

`GetBodyBreakStatus` is the only path that can flip a kid into a
break. It's called every 30s by the kid SPA's polling loop and on
demand from the player. When the threshold is crossed:

- `kid_body_break_state.on_break_until = now + break_minutes`.
- `on_break_reason = randomChoice(profile.reasons)`.
- `accumulator_seconds = 0` (so the post-break stretch starts fresh).
- VoiceMessage is rendered server-side from the configured template
  (`{reason}` placeholder substituted), so the kid client just hands
  it to `speechSynthesis.speak()`.

## Override

The M9 override modal (planned sub-view) can call
`POST /api/kids/override/skip-break` to end the break early. Audit
log row in `override_actions` records the skip.

## Endpoints

- `GET /api/kids/body-break-status` (kid bearer) - render state.
- `POST /api/kids/override/skip-break` (kid bearer + override token).
- `GET /api/admin/profiles/:id/body-breaks` - read profile config.
- `PUT /api/admin/profiles/:id/body-breaks` - update profile config.

## Pending / deferred from M11

- Kid-side overlay (#72) is not implemented. The engine + endpoints
  return a TTS-ready `voiceMessage` field; the kid client needs the
  full-screen lockout + countdown + input-blocker UI. Needs hardware
  validation; defer until the kid SPA gets a serious focus pass.
- Override "Skip body break" sub-view (#74) is not wired into the
  override modal yet. The endpoint is ready.

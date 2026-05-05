# Viewing controls (M12)

Three independently-toggleable effects applied to the kid SPA root
via CSS filter:

- **Dim**: brightness reduction, 0-80% (clamped to 80% so the screen
  is never invisible).
- **Red shift**: hue rotate + sepia toward warm, 0-100%.
- **Auto-off**: full-screen lockout overlay triggered by a configured
  clock time or sleep timer; ends only when the parent override
  clears it.

Volume cap was scoped out (TV variants render volume controls too
inconsistently to expose a reliable knob).

## Effective value resolution

Per profile + per kid (override). For each control:

```
effective = override.value if (override is set AND override.until > now)
            else profile.value
```

Per-kid overrides are TTL-bound. Common TTLs (set by the override
modal): 15min / 30min / 60min / "until next day reset". Expired
overrides fall back to the profile baseline transparently - no
explicit cleanup is needed; the engine ignores them at read time.

## Auto-off

Two independent triggers can flip `auto_off_active = 1`:

1. **Clock cutoff**: `profile.auto_off_clock_time` is "HH:MM" 24h.
   Engine checks at every read: if `now > today's HH:MM` and the kid
   isn't already in auto-off, flip the flag.
2. **Sleep timer**: parent sets via `POST /api/kids/override/viewing/set-sleep-timer`
   `{fireInSecs: N}`. Engine flips the flag when `now > sleep_timer_at`.

Auto-off persists across app restarts (it's a DB row, not a kid SPA
flag), so killing + relaunching the app doesn't clear it. Only the
override `cancel-auto-off` action clears it.

## Endpoints

- `GET /api/kids/viewing-state` (kid bearer) - rendered effective
  state. Polled.
- `POST /api/kids/override/viewing/set-dim` `{value, expiresInSecs}`
- `POST /api/kids/override/viewing/set-red-shift` `{value, expiresInSecs}`
- `POST /api/kids/override/viewing/set-sleep-timer` `{fireInSecs}`
- `POST /api/kids/override/viewing/cancel-auto-off`
- `GET/PUT /api/admin/profiles/:id/viewing-controls`

## Pending / deferred

- Kid-side root-element CSS filter integration (#77) - the engine
  exposes the rendered state but the kid SPA hasn't wired it up. Will
  apply via `<html style="filter: brightness(...) sepia(...) hue-rotate(...)">`
  driven by the polled `/viewing-state` endpoint.
- Override sub-views (#81): set-dim / set-red-shift / sleep-timer /
  cancel-auto-off entry points in the M9 override modal.

## Known limitation

Cancelling an auto-off when the configured clock cutoff has already
passed will re-fire on the next read. Documented behavior; the
parent override should "unlock + grant time via M10" rather than
"cancel and assume the kid is unbothered." A follow-up could track
"acknowledged-after time" so cancel-auto-off survives until the next
day rollover, but it adds state without a clear win.

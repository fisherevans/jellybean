# Time limits (M10)

Per-profile daily watch limits enforced by Jellybean. The kid client
gates tile clicks against a server-computed `can-play` decision and
renders locked tiles when buckets are exhausted; admin-side override
grants briefly lift the limits.

This doc covers the bucket math + storage model + grant semantics.
Kid-side UI (locked tiles, TTS warnings, out-of-time screen) is
covered in `docs/adult-override.md` for the override sub-view and in
`docs/browse-and-layouts.md` for tile rendering hooks.

## Bucket math

The global bucket is the only one keyed off "minutes watched today";
per-show is also minutes-based but scoped to a series id; per-movie
is keyed off "starts today" (one segment per start).

For the global bucket, given a profile config `(daily_cap_minutes,
refill_interval_hours, day_start_hour)`:

```
day_start    = most recent crossing of day_start_hour wall clock
refills/day  = 24 / refill_interval_hours
refill_step  = daily_cap_minutes / (refills/day)
elapsed      = now - day_start
refills_now  = floor(elapsed.hours / refill_interval_hours)
accrued      = min(daily_cap, refills_now * refill_step)
usage_today  = sum(kid_watch_segments.minutes_watched
                    where kid_id=K and day_bucket=today)
grants_active = sum(active global grants)
available    = max(0, accrued - usage_today + grants_active)
locked       = available <= 0
```

### Worked example

Cap 240 min, refill every hour, day start 02:00:

- 02:00: bucket = 0 (just reset).
- 04:00: 2h elapsed, 2 refills, accrued = 20 min.
- 10:00: 8h elapsed, 8 refills, accrued = 80 min.
- 14:00 with 100 min watched: available = max(0, 120 - 100) = 20 min.
- 23:00 with 200 min watched: available = max(0, 220 - 200) = 20 min.

Refill cadence is anchored to `day_start_hour`, not midnight. A profile
configured for 02:00 starts will roll segments tagged `2025-05-04`
back to the `2025-05-03` bucket if their wall clock falls in the
00:00-01:59 window of 2025-05-04.

### Per-show / per-movie

Per-show buckets use the profile's `default_show_cap_minutes` (or a
content-override on the series id) and reset at the same `day_start`
crossing as global. They don't refill during the day.

Per-movie buckets count starts (segment count for that item id today)
against `default_movie_starts` or the override.

`-1` on either override field means "unlimited"; `null` means
"inherit the profile default". Both fields default to null.

## Watch segment derivation

Each `/api/kids/playback/progress` call from the kid client is a
side-effect on `kid_watch_segments`:

- If there's no open segment, open one (started_at = now, ended_at =
  now, minutes_watched = 0). Pointer stored in `kid_open_segments`.
- If there's an open segment for the same kid + same item id and the
  last progress was within `progressGapThreshold` (30s), extend it:
  `ended_at = now`, `minutes_watched += (now - prev_ended_at)/60`.
- Item id swap, paused report, or gap > threshold closes the segment
  and (if not paused) opens a new one.
- `CloseStaleSegments` is a periodic janitor that closes segments
  whose `last_progress_at` is older than 90s; called from the
  admin-side time-status read so it doesn't need a separate worker.

This makes the engine resilient to dropped progress reports: if the
network blips for 60s the segment continues to track wall-clock
minutes; if the kid actually stops watching for >90s the next
progress report opens a fresh segment.

## Grants

Override mode (M9) lets a parent grant time without disabling the
limit globally. Three scopes:

- `global`: lifts the daily bucket by N minutes.
- `series`: lifts the per-show bucket for a specific series id.
- `item`: lifts the per-movie starts cap for a specific movie id.

Three durations:

- Quick grant (`+5/+10/+15/+30/+60 min`): `MinutesGranted=N`,
  `ExpiresAt=null` (= until next day reset).
- "Until end of episode": `MinutesGranted` and `ExpiresAt` both set
  from the kid client's reported `episodeRemainingSeconds`.
- "Until next reset": `MinutesGranted=null`, `ExpiresAt=null`. Engine
  treats this as "available is computed without the global cap until
  day reset"; current implementation simply doesn't add any minutes
  but is pending follow-up - see TODO at the end.

Each grant writes to `override_actions` with `action='grant_time'` and
the request payload as the JSON metadata, so admins can audit who
granted what + when.

## Endpoints

- `GET /api/kids/time-status` (kid bearer) - full TimeStatus.
- `GET /api/kids/items/:id/can-play` (kid bearer) - one-shot gate.
- `POST /api/kids/override/grant-time` (kid bearer + override token) -
  apply a grant.
- `GET /api/admin/profiles/:id/time-limits` - read profile config.
- `PUT /api/admin/profiles/:id/time-limits` - update profile config.
- `GET /api/admin/profiles/:id/content-overrides` - list per-item
  overrides.
- `PUT /api/admin/profiles/:id/content-overrides/:itemId` - upsert
  per-item override.
- `GET /api/admin/kids/:id/time-status` - admin mirror of the kid
  endpoint.

## Pending / deferred from M10

- Kid-side locked-tile rendering (#65) and TTS warnings + out-of-time
  screen (#66) are not implemented. Tiles will look unlocked even when
  the engine reports `Locked: true`. Defer until kid hardware
  validation; the engine + endpoints are ready when that lands.
- Per-content overrides admin UI on the manage-item page (#67) is
  partially implemented (engine + endpoints exist; the manage-item
  page does not yet render a time-limits section).
- Grant-time sub-view on the kid-side override modal (#68) is not
  wired. The grant-time endpoint is callable directly via the API but
  has no UI.
- "Until next reset" grant semantics need a follow-up: the engine
  currently treats it as an empty grant. Either change to "ignore
  global bucket for the rest of the day" or always populate
  `MinutesGranted` from `daily_cap_minutes - usage_today`. Document
  the chosen behavior in this file when it lands.

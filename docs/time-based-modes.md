# Time-based modes (M13)

Per-profile modes scheduled by day-of-week and clock time. While a
mode is active it can override M6 tag filters / M10 time limits / M12
viewing controls and pick a theme. One mode active at a time;
alphabetical name wins on overlap.

## Schedule semantics

`schedule_days` is a 7-bit bitmask: bit 0 = Mon, ..., bit 6 = Sun.

`schedule_start_time` and `schedule_end_time` are 24h `HH:MM`. When
end < start, the schedule wraps midnight - useful for bedtime modes
that span 22:00-06:00.

`scheduleContains(mode, now)`:

1. Map `now.Weekday()` to the bitmask convention (Mon=bit 0).
2. If the bit isn't set, no match.
3. If startMin <= endMin, match if startMin <= curMin < endMin.
4. Else (wrap): match if curMin >= startMin OR curMin < endMin.

## Resolver

`ResolveActiveMode(kidID, now)`:

1. Load `kid_mode_state.override_mode_id`. If it's set + unexpired,
   that's the active mode. Special case: `override_mode_id=0` means
   "force no mode" (parent disabled modes for the TTL).
2. Else, list profile modes whose schedule contains `now`.
3. Pick alphabetically-first by name.
4. Return `{Mode, Source: "schedule" | "override" | "none"}`.

The resolver is read-only. Transitions (writing to
`mode_transitions` audit table + updating `active_mode_id`) are
deferred to a later pass; for now the kid SPA can detect transitions
client-side by comparing successive `/api/kids/active-mode` polls.

## Endpoints

- `GET /api/kids/active-mode` (kid bearer) - returns ActiveMode.
- `POST /api/kids/override/set-mode` (kid bearer + override token):
  `{modeId, expiresInSecs}`. `modeId=0` for force-none.
- `GET /api/admin/profiles/:id/modes` - list modes.
- `POST /api/admin/profiles/:id/modes` - create.
- `PATCH /api/admin/modes/:id` - update.
- `DELETE /api/admin/modes/:id` - delete.

## Pending / deferred

- **#83 effective-config integration**: ResolveActiveMode returns the
  Mode but the M10 / M12 / M6 read paths don't yet consult the JSON
  override columns (`time_limits_json`, `viewing_controls_json`,
  `tag_filters_json`). They keep using profile defaults. Wiring those
  in requires a careful merge layer - design but no implementation
  yet. Themes also live on the mode but aren't applied client-side.
- **#84 theme + transitions**: kid SPA reads `/active-mode` but
  doesn't apply the theme background or play the enter/exit voice
  message yet.
- **#87 override sub-view**: the M9 modal doesn't have a Modes
  sub-menu. Endpoint is ready.

The schema also has a `mode_transitions` audit table that is
populated by the (not yet implemented) transition handler. The
resolver doesn't write to it; that comes with #83's effective-config
pass.

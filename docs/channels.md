# Cable TV channels (M15)

Per-profile named streams that mix tag membership + explicit per-item
picks. The kid SPA's channel-playback engine resolves a channel into
a continuously-shuffled queue with prefetch + skip + Up Next.

## Data model

A channel has:

- `name` (unique within the profile)
- optional `description` / `badge_text` / `badge_color`
- `sort_order`: `random` | `round_robin_tags` | `in_order`
- `tag_ids[]`: items carrying any of these tags are eligible
- `item_ids[]`: explicit Jellyfin item ids; can be pinned to fixed
  positions via `pinned_position` (NULL = unpinned)

Resolution (kid SPA, deferred):

1. Expand `tag_ids` to the set of items carrying any of those tags.
2. Filter against the kid's profile visibility (item must be visible).
3. Filter against M10 time limits + M11 break state + M12 viewing
   auto-off.
4. Union with `item_ids`.
5. Order: `random` -> Fisher-Yates shuffle. `in_order` -> pinned
   slots first, then arbitrary. `round_robin_tags` -> cycle through
   tag groups picking one from each.

## Layout integration

The M8 `layout_rows.type` constraint was extended via the SQLite
table-rebuild dance in 0017_channels.sql to add `'channel'`. A
`channel` row's config carries `{channelId: int}`; the kid SPA's
browse resolver reads it and renders a channel tile that, when
tapped, starts the cable-TV playback engine on that channel id.

## Endpoints

- `GET /api/kids/channels` (kid bearer or admin profileId) - list of
  channels for the active profile.
- `GET /api/admin/profiles/:id/channels` - list.
- `POST /api/admin/profiles/:id/channels` - create.
- `PATCH /api/admin/channels/:id` - update.
- `DELETE /api/admin/channels/:id` - delete.

## Pending / deferred

- **#94 continuous channel playback engine**: the kid SPA's queue
  resolver + prefetch + Up Next overlay + Skip button. The data is
  available; the player needs the queue management layer.
- **#95 channel layout row type + tile rendering**: the `'channel'`
  layout row type is recognized at the schema level but the M8
  browse resolver (internal/server/browse_resolver.go) doesn't yet
  emit channel rows. Wiring is straightforward when the kid playback
  engine is ready.

The schema + admin CRUD ship now; the kid-side runtime is the
remaining work.

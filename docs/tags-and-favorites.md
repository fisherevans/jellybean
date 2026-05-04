# Tags, Favorites, and Profile Tag Filters

Design notes for M6. The kid browse UI (M8) and several downstream
features (time-based modes M13, cable TV M15) depend on this layer
being solid, so the schema choices are documented here and not just
buried in a migration file.

## What problem this solves

Per-profile visibility (`visible / hidden / unset` per item per profile)
is the only categorization Jellybean has today. That's enough to gate
content but not enough to **organize** it. A kid scrolling through 400
visible items has no shape to lean on - they need rows, themes, and
"my favorites." Tags are the primitive that powers all of that.

## Decisions

### Tags are global, not per-profile

One set of tag definitions, shared across all profiles. Tagging an
item with "Adventure" tags it for every profile that can see it.

The alternative (per-profile tags) was rejected: it doubles the
management burden, makes "Adventure" mean different things in
different profiles, and conflicts with the goal of M14 (LLM-assisted
tagging) which needs a single tag namespace to learn from.

### Profile tag filters are the per-profile escape hatch

When a profile needs different behavior for a tag (the "no superhero
content for the toddler profile" case), the admin sets a
**profile_tag_filter**: per (profile, tag), one of `always_visible` or
`always_hidden`. This overrides the per-profile categorization for any
item carrying the tag.

Resolution order, for a given (profile, item):

1. If any tag on the item has `always_hidden` for this profile -> hidden.
2. Else if any tag has `always_visible` for this profile -> visible.
3. Else: fall back to `categorizations.state` for (item, profile);
   `unset` -> hidden.

`always_hidden` wins over `always_visible` when both apply (safer default).

This logic is centralized in `EffectiveItemVisibility(ctx, profileID,
itemID)` and **must** be the only path the kid library queries take.
Direct reads of `categorizations.state` for the kid surface are a bug.

### Favorites are per-kid, not per-profile

A separate `kid_favorites(kid_id, jellyfin_item_id)` table. Two kids
sharing a profile see the same content but keep separate favorite
lists.

Favorites are deliberately **not** modeled as a special "Favorites"
tag. They differ in two ways:

- Cardinality: tags are per-item; favorites are per-kid-per-item.
- Lifecycle: favorites tend to churn (kid adds and removes weekly);
  tags are stable curation artifacts.

The kid browse UI will surface favorites as their own row (M8) with
a heart UX. The heart toggle on the kid TV is **gated behind the
adult override gesture** in M9 (option a from the M6 review). We may
relax to free kid-toggling later (option b) once we see the override
flow in use.

### Tags only attach to movies and series, not seasons or episodes

Episodes inherit any tag on their parent series. Seasons are not
tagged. This keeps the management surface tractable - no admin is
going to tag 200 episodes individually.

### Tags span content types

A tag like "Bedtime" can hold both movies and series. There is no
movie-tag / series-tag namespace split. M16 (additional sources like
YouTube channels) is expected to extend the same `item_tags` table
once those sources are integrated; the schema doesn't bake in a
content-type assumption.

## Schema

Migration: `internal/db/migrations/0009_tags_and_favorites.sql`.

```sql
tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    UNIQUE NOT NULL,
    description TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
)

item_tags (
    jellyfin_item_id TEXT    NOT NULL,
    tag_id           INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    set_at           INTEGER NOT NULL,
    set_by           TEXT,
    PRIMARY KEY (jellyfin_item_id, tag_id)
)

kid_favorites (
    kid_id           INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
    jellyfin_item_id TEXT    NOT NULL,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (kid_id, jellyfin_item_id)
)

profile_tag_filters (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    mode       TEXT    NOT NULL CHECK (mode IN ('always_visible', 'always_hidden')),
    set_at     INTEGER NOT NULL,
    PRIMARY KEY (profile_id, tag_id)
)
```

Items are keyed by `jellyfin_item_id` (string), matching the existing
`categorizations` pattern. There is no local `items` table.

CASCADE on tag delete clears `item_tags` and `profile_tag_filters`.
CASCADE on profile delete clears `profile_tag_filters`. CASCADE on kid
delete clears `kid_favorites`.

Note: deleting a kid also cascades their favorites; if we ever add
"transfer favorites between kids," that's a separate explicit copy
step, not a default behavior.

## Admin surface (M6)

- Tag list page: search, sort by name / count / recency, create / rename / delete.
- Tag detail page: list assigned items, add via a search-filtered picker that defaults to visible-only items.
- Per-tile kebab menu (universal across bulk / swipe / library / search): popover with checkboxes for all tags. Toggling persists immediately.
- Per-kid favorites editor in the kid management view: list current favorites, add via the same search-filtered picker (filtered to items visible *to that kid's profile*).
- Per-profile tag filter editor in the profile management view: per-tag radio of `none | always show | always hide`.

Universal admin override gesture is **defined** here as "hold OK +
Down for ~500ms" so kebab placeholders can stub it, but the gesture
is **wired** in M9 (kid-side override mode).

## Kid surface (M6)

None. Kid library queries route through `EffectiveItemVisibility`
(which now respects profile_tag_filters), but no new rows, no heart
UI, no tag display. M8 surfaces tags in browse rows; M9 surfaces the
favorite heart and the adult-override flow.

## Out of scope

- Tag color, icon, hierarchy. Add later when browse UI demands it.
- Tag history / audit log. `updated_at` only.
- Auto-tagging from titles / metadata / LLMs. M14.
- Episode-level tagging.
- Bulk tag operations beyond per-item PUT (e.g. "tag every series in
  this category"). Watch for friction in real use; add then.

## Open questions

- When a tag is renamed, do we record old names? Probably not in v1;
  `updated_at` is enough.
- When a favorite item is later hidden for the kid's profile, do we
  auto-remove? No - admin sees a warning in the UI and decides. Keeps
  cleanup intentional.
- Do we need a "system tag" concept (uneditable, e.g. for cable-TV
  channels in M15)? Defer; reach for it only if M15's needs make a
  distinct type necessary.

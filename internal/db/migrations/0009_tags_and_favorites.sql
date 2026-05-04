-- Tags, favorites, and profile tag filters (M6).
--
-- Tags are global (one set across all profiles). They attach to movies
-- and series only - episodes inherit any tag on their parent series via
-- application logic, and seasons aren't tagged. This keeps the
-- management surface tractable: admins don't tag individual episodes.
--
-- Favorites are per-kid, NOT per-profile. Two kids sharing a profile see
-- the same content but keep separate favorite lists.
--
-- Profile tag filters are the per-profile escape hatch. When a profile
-- needs different behavior for a tag (e.g. "no superhero content for the
-- toddler profile"), the admin sets a filter row with mode
-- always_visible or always_hidden. The resolution rules live in
-- internal/curation's EffectiveItemVisibility - always_hidden wins over
-- always_visible when both apply on different tags carried by the same
-- item. See docs/tags-and-favorites.md for the full design.

CREATE TABLE tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    UNIQUE NOT NULL,
    description TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- (item, tag) pairs. set_by records the admin Jellyfin user id that
-- applied the tag, mirroring categorizations.set_by.
CREATE TABLE item_tags (
    jellyfin_item_id TEXT    NOT NULL,
    tag_id           INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    set_at           INTEGER NOT NULL,
    set_by           TEXT,
    PRIMARY KEY (jellyfin_item_id, tag_id)
);

-- Index supports "list items carrying tag N" - the tag detail page's
-- primary query. Without it, listing items by tag is a full-table scan.
CREATE INDEX item_tags_tag_id ON item_tags(tag_id);

CREATE TABLE kid_favorites (
    kid_id           INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
    jellyfin_item_id TEXT    NOT NULL,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (kid_id, jellyfin_item_id)
);

CREATE TABLE profile_tag_filters (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    mode       TEXT    NOT NULL CHECK (mode IN ('always_visible', 'always_hidden')),
    set_at     INTEGER NOT NULL,
    PRIMARY KEY (profile_id, tag_id)
);

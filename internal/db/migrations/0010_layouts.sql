-- Layouts (M8): per-profile browse-screen definitions.
--
-- A layout is a named, ordered collection of rows. Each row has a type
-- (continue_watching, favorites, tag, tag_fanout, recently_added,
-- random_unwatched, watch_again) and optional per-type config in
-- config_json. Profiles reference a layout via profiles.layout_id.
--
-- The layout_row_cache table memoizes the resolved item ids for
-- non-deterministic row types (random_unwatched, tag_fanout when set
-- to random, future randomized types). TTL is 60 minutes and the
-- cache is keyed by (profile, layout, row) so two profiles using the
-- same layout get distinct stable orderings. Deterministic rows
-- (continue_watching, favorites, recently_added, single-tag-non-random)
-- are resolved live every request - cache only carries the
-- non-deterministic state we actually need to stabilize.
--
-- Design source: docs/browse-and-layouts.md (to be written).

CREATE TABLE layouts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    UNIQUE NOT NULL,
    description TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- One row per (layout, position). type is enum-checked so the resolver
-- can rely on the value. config_json holds per-type fields:
--   continue_watching: {"max_items": 20}
--   favorites:         {"max_items": 20}
--   tag:               {"tag_id": 7, "sort": "name|random|recently_added", "max_items": 20}
--   tag_fanout:        {"include_tag_ids": [..], "exclude_tag_ids": [..],
--                       "row_order": "alpha|random",
--                       "within_row_sort": "name|random|recently_added",
--                       "max_items": 20}
--   recently_added:    {"lookback_days": 30, "max_items": 20}
--   random_unwatched:  {"max_items": 20}
--   watch_again:       {"min_watch_minutes": 10, "dormant_days": 30, "max_items": 20}
CREATE TABLE layout_rows (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    layout_id   INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    type        TEXT    NOT NULL CHECK (type IN (
        'continue_watching','favorites','tag','tag_fanout',
        'recently_added','random_unwatched','watch_again'
    )),
    title       TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX layout_rows_layout_position ON layout_rows(layout_id, position);

-- Cache of resolved item id orderings for non-deterministic rows.
-- generated_at is unix seconds; the resolver compares against
-- (now - 3600) to decide whether to regenerate. item_ids_json is a
-- JSON array of jellyfin_item_id strings, length-bounded by the row's
-- max_items config.
--
-- Forcing a refresh means deleting matching rows; the next read
-- regenerates. Because the cache is keyed on profile, the same
-- layout reused by two profiles produces independent orderings.
--
-- ON DELETE CASCADE so a layout / row delete (or profile delete)
-- doesn't leave stale cache rows behind.
CREATE TABLE layout_row_cache (
    profile_id   INTEGER NOT NULL REFERENCES profiles(id)    ON DELETE CASCADE,
    layout_id    INTEGER NOT NULL REFERENCES layouts(id)     ON DELETE CASCADE,
    row_id       INTEGER NOT NULL REFERENCES layout_rows(id) ON DELETE CASCADE,
    generated_at INTEGER NOT NULL,
    item_ids_json TEXT   NOT NULL,
    PRIMARY KEY (profile_id, layout_id, row_id)
);
CREATE INDEX layout_row_cache_generated_at ON layout_row_cache(generated_at);

-- Profiles reference their layout. NULL is treated as "use the default
-- layout" by the resolver - no NOT NULL so existing profiles can
-- coexist while we backfill.
ALTER TABLE profiles ADD COLUMN layout_id INTEGER REFERENCES layouts(id);

-- Seed: ship a Default layout matching the milestone spec.
INSERT INTO layouts (name, description, is_default, created_at, updated_at)
VALUES ('Default', 'Default browse layout for new profiles', 1, unixepoch(), unixepoch());

-- Capture the seeded id for the row inserts. SQLite's last_insert_rowid()
-- is per-connection; we know our layout id is 1 in a fresh DB and we
-- look it up explicitly in the row inserts so this remains correct
-- when the migration runs against a non-empty layouts table somehow.
INSERT INTO layout_rows (layout_id, position, type, title, config_json, created_at, updated_at)
SELECT id, 0, 'continue_watching', NULL,
       json_object('max_items', 20),
       unixepoch(), unixepoch()
FROM layouts WHERE name = 'Default';

INSERT INTO layout_rows (layout_id, position, type, title, config_json, created_at, updated_at)
SELECT id, 1, 'favorites', NULL,
       json_object('max_items', 20),
       unixepoch(), unixepoch()
FROM layouts WHERE name = 'Default';

INSERT INTO layout_rows (layout_id, position, type, title, config_json, created_at, updated_at)
SELECT id, 2, 'tag_fanout', NULL,
       json_object('include_tag_ids', json_array(),
                   'exclude_tag_ids', json_array(),
                   'row_order', 'alpha',
                   'within_row_sort', 'name',
                   'max_items', 20),
       unixepoch(), unixepoch()
FROM layouts WHERE name = 'Default';

INSERT INTO layout_rows (layout_id, position, type, title, config_json, created_at, updated_at)
SELECT id, 3, 'recently_added', NULL,
       json_object('lookback_days', 30, 'max_items', 20),
       unixepoch(), unixepoch()
FROM layouts WHERE name = 'Default';

INSERT INTO layout_rows (layout_id, position, type, title, config_json, created_at, updated_at)
SELECT id, 4, 'random_unwatched', NULL,
       json_object('max_items', 20),
       unixepoch(), unixepoch()
FROM layouts WHERE name = 'Default';

-- Backfill: every existing profile points at the default.
UPDATE profiles
SET layout_id = (SELECT id FROM layouts WHERE is_default = 1)
WHERE layout_id IS NULL;

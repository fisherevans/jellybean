-- M15: per-profile channels (Cable TV mode). A channel is a named
-- continuous stream made up of tag-derived items + explicit per-item
-- picks. The kid SPA's channel-playback engine resolves a queue from
-- this definition + the kid's current visibility state.
--
-- The 'channel' layout row type is added to M8's layout_rows.type
-- constraint via the SQLite rebuild dance.

CREATE TABLE channels (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    description  TEXT,
    badge_text   TEXT,
    badge_color  TEXT,
    sort_order   TEXT    NOT NULL DEFAULT 'random'
                 CHECK (sort_order IN ('random', 'round_robin_tags', 'in_order')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE (profile_id, name)
);

CREATE TABLE channel_tags (
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, tag_id)
);

CREATE TABLE channel_items (
    channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    jellyfin_item_id TEXT    NOT NULL,
    pinned_position  INTEGER,
    PRIMARY KEY (channel_id, jellyfin_item_id)
);

-- Extend layout_rows.type CHECK to include 'channel'. SQLite < 3.35
-- can't ALTER CHECK; the rebuild dance is the canonical workaround.
CREATE TABLE layout_rows_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    layout_id   INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    type        TEXT    NOT NULL CHECK (type IN (
        'continue_watching','favorites','tag','tag_fanout',
        'recently_added','random_unwatched','watch_again','channel'
    )),
    title       TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
INSERT INTO layout_rows_new (id, layout_id, position, type, title, config_json, created_at, updated_at)
SELECT id, layout_id, position, type, title, config_json, created_at, updated_at FROM layout_rows;
DROP TABLE layout_rows;
ALTER TABLE layout_rows_new RENAME TO layout_rows;

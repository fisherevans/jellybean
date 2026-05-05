-- Widen channels.sort_order CHECK to include 'distributed_random'.
-- SQLite can't ALTER a CHECK constraint, so rebuild the table.

CREATE TABLE channels_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    description  TEXT,
    badge_text   TEXT,
    badge_color  TEXT,
    sort_order   TEXT    NOT NULL DEFAULT 'random'
                 CHECK (sort_order IN ('random', 'distributed_random', 'round_robin_tags', 'in_order')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE (profile_id, name)
);
INSERT INTO channels_new (id, profile_id, name, description, badge_text, badge_color, sort_order, created_at, updated_at)
SELECT id, profile_id, name, description, badge_text, badge_color, sort_order, created_at, updated_at FROM channels;
DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;

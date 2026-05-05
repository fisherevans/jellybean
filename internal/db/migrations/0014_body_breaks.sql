-- M11: per-profile body-break cadence + per-kid accumulator state.
-- The engine in internal/curation/bodybreaks.go increments the
-- accumulator on active /play, decays on pause / menu / browse, and
-- triggers a break when the configured play_minutes threshold is hit.

CREATE TABLE profile_body_breaks (
    profile_id              INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    enabled                 INTEGER NOT NULL DEFAULT 0,
    play_minutes            INTEGER NOT NULL DEFAULT 30,
    break_minutes           INTEGER NOT NULL DEFAULT 5,
    voice_message_template  TEXT    NOT NULL DEFAULT 'Time to take a break. How about some {reason}?',
    reasons_json            TEXT    NOT NULL DEFAULT '["water","stretching","a bathroom break","a snack"]',
    updated_at              INTEGER NOT NULL
);

CREATE TABLE kid_body_break_state (
    kid_id              INTEGER PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
    accumulator_seconds REAL    NOT NULL DEFAULT 0,
    last_updated_at     INTEGER NOT NULL,
    current_item_id     TEXT,
    current_series_id   TEXT,
    on_break_until      INTEGER,
    on_break_reason     TEXT,
    last_break_at       INTEGER
);

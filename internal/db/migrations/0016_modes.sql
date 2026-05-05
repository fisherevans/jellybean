-- M13: per-profile time-based modes. Each mode has a schedule
-- (day-of-week bitmask + start/end clock time, allowing midnight
-- wrap) plus optional overrides for tag filters / time limits /
-- viewing controls / theme. Resolver picks the alphabetically-first
-- mode whose schedule contains "now" (or honors the kid's
-- override_mode_id when set + unexpired).

CREATE TABLE profile_modes (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id               INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name                     TEXT    NOT NULL,
    schedule_days            INTEGER NOT NULL DEFAULT 0,
    schedule_start_time      TEXT    NOT NULL DEFAULT '00:00',
    schedule_end_time        TEXT    NOT NULL DEFAULT '00:00',
    tag_filters_json         TEXT    NOT NULL DEFAULT '[]',
    time_limits_json         TEXT,
    viewing_controls_json    TEXT,
    theme_key                TEXT    NOT NULL DEFAULT 'default',
    enter_voice_message      TEXT,
    exit_voice_message       TEXT,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL,
    UNIQUE (profile_id, name)
);

CREATE TABLE kid_mode_state (
    kid_id                  INTEGER PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
    active_mode_id          INTEGER REFERENCES profile_modes(id) ON DELETE SET NULL,
    active_since            INTEGER,
    override_mode_id        INTEGER REFERENCES profile_modes(id) ON DELETE SET NULL,
    override_mode_until     INTEGER,
    last_transition_at      INTEGER,
    updated_at              INTEGER NOT NULL
);

CREATE TABLE mode_transitions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kid_id        INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
    from_mode_id  INTEGER REFERENCES profile_modes(id) ON DELETE SET NULL,
    to_mode_id    INTEGER REFERENCES profile_modes(id) ON DELETE SET NULL,
    occurred_at   INTEGER NOT NULL
);
CREATE INDEX mode_transitions_kid_at ON mode_transitions(kid_id, occurred_at);

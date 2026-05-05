-- Jellybean schema baseline. The project is pre-v1 local dev; the
-- previous 24 numbered migrations were squashed into this single
-- file so future readers don't have to replay the old iteration
-- history. Going forward, new migrations should be additive on top
-- of this baseline.

-- ---- session + auth ---------------------------------------------

CREATE TABLE sessions (
    token_hash    TEXT    PRIMARY KEY,
    user_id       TEXT    NOT NULL,
    user_name     TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
);
CREATE INDEX sessions_last_seen ON sessions(last_seen_at);

CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    token_hash   TEXT    NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
);

CREATE TABLE api_access_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id       INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
    method       TEXT    NOT NULL,
    path         TEXT    NOT NULL,
    status       INTEGER NOT NULL,
    occurred_at  INTEGER NOT NULL
);
CREATE INDEX api_access_log_key_time ON api_access_log(key_id, occurred_at DESC);
CREATE INDEX api_access_log_time     ON api_access_log(occurred_at DESC);

-- ---- profiles + kids ---------------------------------------------

CREATE TABLE layouts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    UNIQUE NOT NULL,
    description TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE profiles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    UNIQUE NOT NULL,
    description      TEXT,
    default_language TEXT    NOT NULL DEFAULT 'eng',
    layout_id        INTEGER REFERENCES layouts(id),
    created_at       INTEGER NOT NULL
);

CREATE TABLE kids (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    profile_id        INTEGER NOT NULL REFERENCES profiles(id),
    jellyfin_user_id  TEXT    NOT NULL UNIQUE,
    created_at        INTEGER NOT NULL
);
CREATE INDEX kids_profile_id ON kids(profile_id);

-- ---- per-profile categorization (M2) -----------------------------

CREATE TABLE categorizations (
    jellyfin_item_id TEXT    NOT NULL,
    profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    state            TEXT    NOT NULL CHECK (state IN ('visible', 'hidden')),
    source           TEXT    NOT NULL CHECK (source IN ('manual', 'auto-suggested')),
    set_at           INTEGER NOT NULL,
    set_by           TEXT,
    orphan_at        INTEGER,
    PRIMARY KEY (jellyfin_item_id, profile_id)
);
CREATE INDEX categorizations_profile_state ON categorizations(profile_id, state);
CREATE INDEX categorizations_orphan_at     ON categorizations(orphan_at);

CREATE TABLE categorization_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    jellyfin_item_id TEXT    NOT NULL,
    profile_id       INTEGER NOT NULL,
    from_state       TEXT,
    to_state         TEXT,
    changed_by       TEXT,
    changed_at       INTEGER NOT NULL
);
CREATE INDEX categorization_history_changed_at ON categorization_history(changed_at DESC);
CREATE INDEX categorization_history_item_id    ON categorization_history(jellyfin_item_id);
CREATE INDEX categorization_history_profile_id ON categorization_history(profile_id);

-- ---- tags + favorites + tag rules (M6) ---------------------------

CREATE TABLE tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    UNIQUE NOT NULL,
    description TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE item_tags (
    jellyfin_item_id TEXT    NOT NULL,
    tag_id           INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    set_at           INTEGER NOT NULL,
    set_by           TEXT,
    PRIMARY KEY (jellyfin_item_id, tag_id)
);
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

-- ---- layout rows (M8) --------------------------------------------

CREATE TABLE layout_rows (
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

CREATE TABLE layout_row_cache (
    profile_id   INTEGER NOT NULL REFERENCES profiles(id)    ON DELETE CASCADE,
    layout_id    INTEGER NOT NULL REFERENCES layouts(id)     ON DELETE CASCADE,
    row_id       INTEGER NOT NULL REFERENCES layout_rows(id) ON DELETE CASCADE,
    generated_at INTEGER NOT NULL,
    item_ids_json TEXT   NOT NULL,
    PRIMARY KEY (profile_id, layout_id, row_id)
);
CREATE INDEX layout_row_cache_generated_at ON layout_row_cache(generated_at);

-- ---- override (M9) -----------------------------------------------

CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE override_config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    pin_hash        TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE kid_override_sessions (
    kid_id     INTEGER PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used  INTEGER NOT NULL
);
CREATE INDEX kid_override_sessions_expires ON kid_override_sessions(expires_at);

CREATE TABLE override_actions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kid_id       INTEGER REFERENCES kids(id) ON DELETE SET NULL,
    action       TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    payload      TEXT,
    performed_at INTEGER NOT NULL
);
CREATE INDEX override_actions_kid_time ON override_actions(kid_id, performed_at DESC);

-- ---- time limits (M10) -------------------------------------------

CREATE TABLE profile_time_limits (
    profile_id                INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    enabled                   INTEGER NOT NULL DEFAULT 0,
    daily_cap_minutes         INTEGER NOT NULL DEFAULT 240,
    refill_interval_hours     INTEGER NOT NULL DEFAULT 1
                              CHECK (refill_interval_hours IN (1, 4, 12, 24)),
    day_start_hour            INTEGER NOT NULL DEFAULT 2
                              CHECK (day_start_hour BETWEEN 0 AND 23),
    default_show_cap_minutes  INTEGER,
    default_movie_starts      INTEGER,
    updated_at                INTEGER NOT NULL
);

CREATE TABLE content_time_overrides (
    profile_id            INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    jellyfin_item_id      TEXT    NOT NULL,
    override_cap_minutes  INTEGER,
    override_starts       INTEGER,
    updated_at            INTEGER NOT NULL,
    PRIMARY KEY (profile_id, jellyfin_item_id)
);

CREATE TABLE kid_watch_segments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kid_id           INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
    jellyfin_item_id TEXT    NOT NULL,
    series_id        TEXT,
    started_at       INTEGER NOT NULL,
    ended_at         INTEGER NOT NULL,
    minutes_watched  REAL    NOT NULL,
    day_bucket       TEXT    NOT NULL
);
CREATE INDEX kid_watch_segments_kid_day        ON kid_watch_segments(kid_id, day_bucket);
CREATE INDEX kid_watch_segments_kid_series_day ON kid_watch_segments(kid_id, series_id, day_bucket);
CREATE INDEX kid_watch_segments_kid_item_day   ON kid_watch_segments(kid_id, jellyfin_item_id, day_bucket);

CREATE TABLE kid_open_segments (
    kid_id           INTEGER PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
    segment_id       INTEGER NOT NULL REFERENCES kid_watch_segments(id) ON DELETE CASCADE,
    last_progress_at INTEGER NOT NULL
);

CREATE TABLE kid_time_grants (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kid_id          INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
    granted_at      INTEGER NOT NULL,
    granted_by      TEXT NOT NULL,
    minutes_granted INTEGER,
    expires_at      INTEGER,
    scope           TEXT NOT NULL CHECK (scope IN ('global', 'item', 'series')),
    scope_id        TEXT
);
CREATE INDEX kid_time_grants_kid_expires ON kid_time_grants(kid_id, expires_at);

-- ---- body breaks (M11) -------------------------------------------

CREATE TABLE profile_body_breaks (
    profile_id              INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    enabled                 INTEGER NOT NULL DEFAULT 0,
    play_minutes            INTEGER NOT NULL DEFAULT 30,
    break_minutes           INTEGER NOT NULL DEFAULT 5,
    voice_message_template  TEXT    NOT NULL DEFAULT 'Time for a quick break. {reason}',
    reasons_json            TEXT    NOT NULL DEFAULT '["Grab a sip of water.","Take a quick potty break.","Stand up and stretch.","Tidy up some toys while we wait."]',
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

-- ---- viewing controls (M12) --------------------------------------
-- Bedtime hard cutoff lives at the profile level. Dim + warm tint
-- live on profile_modes (configured per mode, e.g. only during a
-- Bedtime mode). Per-kid overrides can temporarily replace the
-- mode's effective values.

CREATE TABLE profile_viewing_controls (
    profile_id              INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    auto_off_clock_time     TEXT,
    updated_at              INTEGER NOT NULL
);

CREATE TABLE kid_viewing_overrides (
    kid_id                    INTEGER PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
    dim_override              INTEGER,
    dim_override_until        INTEGER,
    red_shift_override        INTEGER,
    red_shift_override_until  INTEGER,
    sleep_timer_at            INTEGER,
    auto_off_active           INTEGER NOT NULL DEFAULT 0,
    auto_off_reason           TEXT,
    updated_at                INTEGER NOT NULL
);

-- ---- time-based modes (M13) --------------------------------------

CREATE TABLE profile_modes (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id               INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name                     TEXT    NOT NULL,
    schedule_days            INTEGER NOT NULL DEFAULT 0,
    schedule_start_time      TEXT    NOT NULL DEFAULT '00:00',
    schedule_end_time        TEXT    NOT NULL DEFAULT '00:00',
    tag_filters_json         TEXT    NOT NULL DEFAULT '[]',
    required_tag_ids_json    TEXT    NOT NULL DEFAULT '[]',
    time_limits_json         TEXT,
    dim_percent              INTEGER NOT NULL DEFAULT 0
                             CHECK (dim_percent BETWEEN 0 AND 80),
    warm_tint_percent        INTEGER NOT NULL DEFAULT 0
                             CHECK (warm_tint_percent BETWEEN 0 AND 100),
    layout_id                INTEGER REFERENCES layouts(id) ON DELETE SET NULL,
    theme_key                TEXT    NOT NULL DEFAULT 'default',
    enter_voice_message      TEXT,
    exit_voice_message       TEXT,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL,
    UNIQUE (profile_id, name)
);

CREATE TABLE kid_mode_state (
    kid_id              INTEGER PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
    active_mode_id      INTEGER REFERENCES profile_modes(id) ON DELETE SET NULL,
    active_since        INTEGER,
    override_mode_id    INTEGER REFERENCES profile_modes(id) ON DELETE SET NULL,
    override_mode_until INTEGER,
    last_transition_at  INTEGER,
    updated_at          INTEGER NOT NULL
);

CREATE TABLE mode_transitions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kid_id        INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
    from_mode_id  INTEGER REFERENCES profile_modes(id) ON DELETE SET NULL,
    to_mode_id    INTEGER REFERENCES profile_modes(id) ON DELETE SET NULL,
    occurred_at   INTEGER NOT NULL
);
CREATE INDEX mode_transitions_kid_at ON mode_transitions(kid_id, occurred_at);

-- ---- channels (M15) ----------------------------------------------

CREATE TABLE channels (
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

CREATE TABLE channel_tags (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, tag_id)
);

CREATE TABLE channel_items (
    channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    jellyfin_item_id TEXT    NOT NULL,
    pinned_position  INTEGER,
    PRIMARY KEY (channel_id, jellyfin_item_id)
);

-- ---- seed data ---------------------------------------------------

-- Default layout with the M8 starter rows. The protected Default
-- profile points at this layout. Override config is a singleton row.
-- App settings get a public_url placeholder so the QR generator
-- never has to UPSERT.

INSERT INTO layouts (name, description, is_default, created_at, updated_at)
VALUES ('Default', 'Default browse layout for new profiles', 1, unixepoch(), unixepoch());

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

INSERT INTO profiles (name, description, default_language, layout_id, created_at)
VALUES (
    'Default',
    'Auto-created default profile.',
    'eng',
    (SELECT id FROM layouts WHERE name = 'Default'),
    unixepoch()
);

INSERT INTO override_config (id, updated_at) VALUES (1, unixepoch());

INSERT INTO app_settings (key, value, updated_at)
VALUES ('public_url', '', unixepoch());

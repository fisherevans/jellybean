-- Adult override mode (M9). Long-press UP on a focused kid tile
-- triggers a PIN-gated modal that exposes per-item edit actions
-- (favorite, tags, hide, mark watched/unwatched, QR deep-link).
-- 60s sliding TTL on the unlock so consecutive edits don't re-prompt.
--
-- Schema overview:
--   override_config       single-row global state: PIN hash + lockout
--   kid_override_sessions per-kid bearer-style override unlock token
--   override_actions      append-only audit log of override actions
--   app_settings          general key-value bag for cross-cutting
--                          settings (M9 introduces it; M10/M11 reuse)

CREATE TABLE override_config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    pin_hash        TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL
);
INSERT INTO override_config (id, updated_at) VALUES (1, unixepoch());

-- One active session per kid is sufficient for v1 - the kid is
-- watching one TV at a time; the parent unlocking on TV A doesn't
-- need to leak access to TV B.
CREATE TABLE kid_override_sessions (
    kid_id     INTEGER PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used  INTEGER NOT NULL
);
CREATE INDEX kid_override_sessions_expires ON kid_override_sessions(expires_at);

-- Audit log. CASCADE on kid delete sets kid_id NULL so historical
-- audit rows survive even if the kid record is removed - aligns
-- with how api_access_log treats deleted api_keys.
CREATE TABLE override_actions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kid_id       INTEGER REFERENCES kids(id) ON DELETE SET NULL,
    action       TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    payload      TEXT,
    performed_at INTEGER NOT NULL
);
CREATE INDEX override_actions_kid_time ON override_actions(kid_id, performed_at DESC);

-- Generic key-value settings. M9 lands public_url; future
-- milestones (time limits, body breaks, viewing controls) will
-- park their cross-cutting knobs here too. Anything that's
-- per-profile or per-kid stays in a typed table; only
-- truly-singleton settings (like the public URL the QR generator
-- needs) go here.
CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
INSERT INTO app_settings (key, value, updated_at)
VALUES ('public_url', '', unixepoch())
ON CONFLICT DO NOTHING;

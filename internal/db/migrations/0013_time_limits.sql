-- M10: per-profile daily time limits, per-content overrides, watch
-- segment ledger derived from playback reports, and override-granted
-- time bonuses. The bucket engine in internal/curation/timelimits.go
-- reads from these tables; admins write to profile_time_limits +
-- content_time_overrides via the admin web UI; grants are written by
-- the M9 override flow.

CREATE TABLE profile_time_limits (
    profile_id              INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    enabled                 INTEGER NOT NULL DEFAULT 0,
    daily_cap_minutes       INTEGER NOT NULL DEFAULT 240,
    refill_interval_hours   INTEGER NOT NULL DEFAULT 1
                            CHECK (refill_interval_hours IN (1, 4, 12, 24)),
    day_start_hour          INTEGER NOT NULL DEFAULT 2
                            CHECK (day_start_hour BETWEEN 0 AND 23),
    default_show_cap_minutes  INTEGER,
    default_movie_starts      INTEGER,
    updated_at              INTEGER NOT NULL
);

CREATE TABLE content_time_overrides (
    profile_id        INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    jellyfin_item_id  TEXT    NOT NULL,
    override_cap_minutes  INTEGER,
    override_starts       INTEGER,
    updated_at        INTEGER NOT NULL,
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
CREATE INDEX kid_watch_segments_kid_day ON kid_watch_segments(kid_id, day_bucket);
CREATE INDEX kid_watch_segments_kid_series_day ON kid_watch_segments(kid_id, series_id, day_bucket);
CREATE INDEX kid_watch_segments_kid_item_day ON kid_watch_segments(kid_id, jellyfin_item_id, day_bucket);

-- Open segment per kid (one at a time). The progress-report side-
-- effect updates ended_at + minutes_watched until the segment closes
-- (stopped report or staleness threshold). A pointer table keeps the
-- "currently open" rowid so the side-effect doesn't have to scan.
CREATE TABLE kid_open_segments (
    kid_id          INTEGER PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
    segment_id      INTEGER NOT NULL REFERENCES kid_watch_segments(id) ON DELETE CASCADE,
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

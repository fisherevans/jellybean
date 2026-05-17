-- item_metadata is a local mirror of the subset of Jellyfin item fields
-- Jellybean's admin + kid list endpoints render. Refreshed by a background
-- ticker (internal/itemcache) so reads never block on a Jellyfin round trip.
--
-- Scope: Movie + Series only. Episodes intentionally not cached - the
-- decorate paths fall back to live Jellyfin for episode-type ids
-- (continue-watching etc.). UserData (per-user resume / watched flags) is
-- never cached here; it stays a live per-request fetch.
--
-- Refresh semantics: each scan bumps last_scan_id, upserts all current
-- rows with that id, then deletes anything whose last_scan_id is older.
-- Bundled inside one transaction so readers never see a half-empty table.
CREATE TABLE item_metadata (
    id                              TEXT    PRIMARY KEY,
    name                            TEXT    NOT NULL,
    sort_name                       TEXT    NOT NULL,
    type                            TEXT    NOT NULL,
    production_year                 INTEGER,
    run_time_ticks                  INTEGER,
    primary_image_tag               TEXT,
    date_created                    TEXT,
    series_id                       TEXT,
    series_name                     TEXT,
    overview                        TEXT,
    official_rating                 TEXT,
    primary_audio_language          TEXT,
    audio_languages_json            TEXT    NOT NULL DEFAULT '[]',
    has_non_default_audio_language  INTEGER NOT NULL DEFAULT 0,
    updated_at                      INTEGER NOT NULL,
    last_scan_id                    INTEGER NOT NULL
);
CREATE INDEX idx_item_metadata_sort_name ON item_metadata(sort_name COLLATE NOCASE);
CREATE INDEX idx_item_metadata_type      ON item_metadata(type);

-- item_metadata_state holds the bookkeeping the cache needs to report
-- status + drive its scan_id counter. Single-row-per-key KV table so we
-- never have to migrate when new status fields appear.
--
-- Expected keys (all string values):
--   last_scan_id              integer counter, increments per Refresh
--   last_full_scan_at         unix seconds, end-of-refresh timestamp
--   last_full_scan_duration_ms millis spent inside Refresh
--   last_scan_item_count      rows upserted in the last successful refresh
--   last_scan_error           empty on success, otherwise the error msg
CREATE TABLE item_metadata_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO item_metadata_state (key, value) VALUES ('last_scan_id', '0');

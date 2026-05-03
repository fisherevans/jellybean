-- Tombstone column for categorizations whose Jellyfin item id no longer
-- resolves. The reconciliation pass (POST /api/admin/maintenance/reconcile)
-- batches Jellyfin lookups and stamps orphan_at on rows whose item id is
-- absent from the catalog; if the item later reappears (re-import with the
-- same id) the column is cleared.
--
-- We tombstone instead of deleting because categorization_history
-- references jellyfin_item_id and we want to recover gracefully on
-- re-import. Reads that feed the kid library + admin curation UIs filter
-- orphan_at IS NOT NULL out; recent-activity history is unaffected.
--
-- SQLite supports ADD COLUMN, but we use the table-rebuild pattern (per
-- 0007_drop_kid_secrets.sql) to keep the column definition canonical and
-- avoid the < 3.35 inconsistency around defaulted columns.
CREATE TABLE categorizations_new (
    jellyfin_item_id TEXT    NOT NULL,
    profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    state            TEXT    NOT NULL CHECK (state IN ('visible', 'hidden')),
    source           TEXT    NOT NULL CHECK (source IN ('manual', 'auto-suggested')),
    set_at           INTEGER NOT NULL,
    set_by           TEXT,
    orphan_at        INTEGER,
    PRIMARY KEY (jellyfin_item_id, profile_id)
);

INSERT INTO categorizations_new (jellyfin_item_id, profile_id, state, source, set_at, set_by, orphan_at)
SELECT jellyfin_item_id, profile_id, state, source, set_at, set_by, NULL
FROM categorizations;

DROP INDEX IF EXISTS categorizations_profile_state;
DROP TABLE categorizations;
ALTER TABLE categorizations_new RENAME TO categorizations;

CREATE INDEX categorizations_profile_state ON categorizations(profile_id, state);
CREATE INDEX categorizations_orphan_at     ON categorizations(orphan_at);

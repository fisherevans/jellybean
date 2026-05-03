-- Replace global age-based categorizations with per-profile visibility.
-- Each (item, profile) pair is independently visible / hidden / unset.
-- A future "Zoe" profile gets its own triage pass; Ollie's decisions
-- don't carry over.
--
-- Migration of existing data: anything previously marked min_age < 13 maps
-- to "visible" for the Default profile; min_age >= 13 maps to "hidden".
-- NULL min_age rows had nothing useful, drop them.

-- New categorizations table.
CREATE TABLE categorizations_new (
    jellyfin_item_id TEXT    NOT NULL,
    profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    state            TEXT    NOT NULL CHECK (state IN ('visible', 'hidden')),
    source           TEXT    NOT NULL CHECK (source IN ('manual', 'auto-suggested')),
    set_at           INTEGER NOT NULL,
    set_by           TEXT,
    PRIMARY KEY (jellyfin_item_id, profile_id)
);

INSERT INTO categorizations_new (jellyfin_item_id, profile_id, state, source, set_at, set_by)
SELECT
    jellyfin_item_id,
    (SELECT id FROM profiles WHERE name = 'Default'),
    CASE WHEN min_age < 13 THEN 'visible' ELSE 'hidden' END,
    source,
    set_at,
    set_by
FROM categorizations
WHERE min_age IS NOT NULL;

DROP INDEX IF EXISTS categorizations_min_age;
DROP TABLE categorizations;
ALTER TABLE categorizations_new RENAME TO categorizations;

CREATE INDEX categorizations_profile_state ON categorizations(profile_id, state);

-- Rebuild history with the same shape.
CREATE TABLE categorization_history_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    jellyfin_item_id TEXT    NOT NULL,
    profile_id       INTEGER NOT NULL,
    from_state       TEXT,
    to_state         TEXT,
    changed_by       TEXT,
    changed_at       INTEGER NOT NULL
);

INSERT INTO categorization_history_new
    (jellyfin_item_id, profile_id, from_state, to_state, changed_by, changed_at)
SELECT
    jellyfin_item_id,
    (SELECT id FROM profiles WHERE name = 'Default'),
    CASE
        WHEN from_min_age IS NULL THEN NULL
        WHEN from_min_age < 13 THEN 'visible'
        ELSE 'hidden'
    END,
    CASE
        WHEN to_min_age IS NULL THEN NULL
        WHEN to_min_age < 13 THEN 'visible'
        ELSE 'hidden'
    END,
    changed_by,
    changed_at
FROM categorization_history;

DROP INDEX IF EXISTS categorization_history_changed_at;
DROP INDEX IF EXISTS categorization_history_item_id;
DROP TABLE categorization_history;
ALTER TABLE categorization_history_new RENAME TO categorization_history;

CREATE INDEX categorization_history_changed_at ON categorization_history(changed_at DESC);
CREATE INDEX categorization_history_item_id   ON categorization_history(jellyfin_item_id);
CREATE INDEX categorization_history_profile_id ON categorization_history(profile_id);

-- Drop the profile age-range columns; visibility is now expressed in the
-- per-profile categorizations table.
ALTER TABLE profiles DROP COLUMN min_age;
ALTER TABLE profiles DROP COLUMN max_age;

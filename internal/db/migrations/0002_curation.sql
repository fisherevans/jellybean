-- Profiles abstraction: a content rule set that kids belong to.
-- v1 has no rules; profiles are just name + description and gate nothing.
-- Future milestones add rules per profile (e.g. age cutoffs, genre allowlists).
CREATE TABLE profiles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    UNIQUE NOT NULL,
    description TEXT,
    created_at  INTEGER NOT NULL
);

INSERT INTO profiles (name, description, created_at)
VALUES ('Default', 'Auto-created default profile.', unixepoch());

-- Kids: each maps to a Jellyfin user. The Jellyfin token is minted via
-- AuthenticateByName when the kid is added; the kid's password is never
-- persisted. The api_key_hash is SHA-256 of the raw key the kid's TV uses.
CREATE TABLE kids (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    profile_id        INTEGER NOT NULL REFERENCES profiles(id),
    jellyfin_user_id  TEXT    NOT NULL UNIQUE,
    jellyfin_token    TEXT,
    api_key_hash      TEXT    NOT NULL UNIQUE,
    created_at        INTEGER NOT NULL
);

CREATE INDEX kids_profile_id ON kids(profile_id);

-- Categorizations: binary kid-or-adult per item. Profiles will gate
-- visibility later but this column is global.
CREATE TABLE categorizations (
    jellyfin_item_id TEXT    PRIMARY KEY,
    category         TEXT    NOT NULL CHECK (category IN ('kid', 'adult', 'uncategorized')),
    source           TEXT    NOT NULL CHECK (source IN ('manual', 'auto-suggested')),
    set_at           INTEGER NOT NULL,
    set_by           TEXT
);

CREATE INDEX categorizations_category ON categorizations(category);

-- Append-only history of category changes. Powers the recent-activity view
-- and lets the parent see what changed and undo recent mistakes.
CREATE TABLE categorization_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    jellyfin_item_id TEXT    NOT NULL,
    from_category    TEXT,
    to_category      TEXT    NOT NULL,
    changed_by       TEXT,
    changed_at       INTEGER NOT NULL
);

CREATE INDEX categorization_history_changed_at ON categorization_history(changed_at DESC);
CREATE INDEX categorization_history_item_id   ON categorization_history(jellyfin_item_id);

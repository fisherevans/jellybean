-- Auth pivot (docs/auth-pivot-plan.md): kids no longer carry an API key
-- or a server-stored Jellyfin token. The TV / app authenticates via
-- standard Jellyfin login and presents its own bearer token on every
-- request. Jellybean only needs the (jellyfin_user_id -> profile_id)
-- mapping plus a display name.
--
-- SQLite < 3.35 can't DROP COLUMN; use the table-rebuild dance.

CREATE TABLE kids_new (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    profile_id        INTEGER NOT NULL REFERENCES profiles(id),
    jellyfin_user_id  TEXT    NOT NULL UNIQUE,
    created_at        INTEGER NOT NULL
);

INSERT INTO kids_new (id, name, profile_id, jellyfin_user_id, created_at)
SELECT id, name, profile_id, jellyfin_user_id, created_at
FROM kids;

DROP TABLE kids;
ALTER TABLE kids_new RENAME TO kids;
CREATE INDEX kids_profile_id ON kids(profile_id);

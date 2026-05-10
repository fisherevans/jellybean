-- Phone-pairing login sessions for the kid TV.
--
-- The TV calls /api/kids/auth/pair/start which mints a row here with a
-- short human-friendly code (printed in a QR), a polling token (used by
-- the TV to fetch status), and an expiry. The parent loads
-- /pair/<short_code> on their phone, posts Jellyfin credentials, and
-- the server forwards to AuthenticateByName. On success we stash the
-- resulting Jellyfin user id + access token here. The TV's poll then
-- finds status='complete' and seals the session.
--
-- SQLite over an in-memory map: server restarts shouldn't void a
-- pending pairing the parent is mid-keystroke on. Cleanup is a periodic
-- DELETE of expired rows (see internal/curation/pair.go).
CREATE TABLE pair_sessions (
    short_code        TEXT    PRIMARY KEY,
    polling_token     TEXT    NOT NULL UNIQUE,
    status            TEXT    NOT NULL CHECK (status IN ('pending', 'complete', 'expired')),
    created_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    completed_at      INTEGER,
    jellyfin_user_id  TEXT,
    jellyfin_user_name TEXT,
    jellyfin_token    TEXT,
    device_id         TEXT
);
CREATE INDEX pair_sessions_expires_at ON pair_sessions(expires_at);

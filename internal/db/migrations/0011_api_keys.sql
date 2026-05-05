-- API keys for headless admin access (M14).
--
-- Bearer-token auth equivalent to the admin cookie. Used to point an
-- LLM at the admin REST API for tag population, programmatic
-- maintenance scripts, etc. Single permission level (no scopes); a
-- bearer either has full admin access or no access. Granular scopes
-- are out of scope for v1 - re-evaluate when there's a real consumer
-- needing read-only / per-resource access.
--
-- token_hash holds the sha256 hex of the plaintext token. We never
-- store plaintext - the create flow returns the token to the caller
-- once and only once; revocation is the recovery for "I lost my key."
--
-- api_access_log records every successful bearer-authed admin call.
-- The insert runs async on the request-handler hot path so the log
-- never blocks legitimate requests. key_id ON DELETE SET NULL so a
-- revoke + delete keeps the access history intact for auditing.

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

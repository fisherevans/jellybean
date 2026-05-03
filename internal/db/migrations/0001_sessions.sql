CREATE TABLE sessions (
    token_hash    TEXT    PRIMARY KEY,
    user_id       TEXT    NOT NULL,
    user_name     TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
);

CREATE INDEX sessions_last_seen ON sessions(last_seen_at);

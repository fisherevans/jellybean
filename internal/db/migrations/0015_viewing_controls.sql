-- M12: per-profile viewing controls (dim, red-shift, clock-based
-- auto-off) and per-kid overrides for the same controls. The kid SPA
-- applies the rendered effective values via CSS filter on the root.

CREATE TABLE profile_viewing_controls (
    profile_id              INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    dim_percent             INTEGER NOT NULL DEFAULT 0
                            CHECK (dim_percent BETWEEN 0 AND 80),
    red_shift_percent       INTEGER NOT NULL DEFAULT 0
                            CHECK (red_shift_percent BETWEEN 0 AND 100),
    auto_off_clock_time     TEXT,
    auto_off_on_time_limit  INTEGER NOT NULL DEFAULT 0,
    updated_at              INTEGER NOT NULL
);

CREATE TABLE kid_viewing_overrides (
    kid_id                    INTEGER PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
    dim_override              INTEGER,
    dim_override_until        INTEGER,
    red_shift_override        INTEGER,
    red_shift_override_until  INTEGER,
    sleep_timer_at            INTEGER,
    auto_off_active           INTEGER NOT NULL DEFAULT 0,
    auto_off_reason           TEXT,
    updated_at                INTEGER NOT NULL
);

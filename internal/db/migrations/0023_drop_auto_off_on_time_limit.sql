-- Drop profile_viewing_controls.auto_off_on_time_limit. The toggle
-- was a confusing opt-in for "show the rolling-bucket lockout
-- overlay when M10 hits zero" - that's the only sensible behavior,
-- so we always show it now and the column is dead.
--
-- SQLite < 3.35 can't ALTER DROP COLUMN; rebuild the table.

CREATE TABLE profile_viewing_controls_new (
    profile_id              INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    dim_percent             INTEGER NOT NULL DEFAULT 0
                            CHECK (dim_percent BETWEEN 0 AND 80),
    red_shift_percent       INTEGER NOT NULL DEFAULT 0
                            CHECK (red_shift_percent BETWEEN 0 AND 100),
    auto_off_clock_time     TEXT,
    updated_at              INTEGER NOT NULL
);
INSERT INTO profile_viewing_controls_new (profile_id, dim_percent, red_shift_percent, auto_off_clock_time, updated_at)
SELECT profile_id, dim_percent, red_shift_percent, auto_off_clock_time, updated_at FROM profile_viewing_controls;
DROP TABLE profile_viewing_controls;
ALTER TABLE profile_viewing_controls_new RENAME TO profile_viewing_controls;

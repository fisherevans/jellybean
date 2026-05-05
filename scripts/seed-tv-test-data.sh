#!/usr/bin/env bash
# Seed Jellybean's curation DB with realistic test data so the kid TV
# client has populated rows + active modes + a channel to exercise.
#
# Idempotent-ish: tags use INSERT OR IGNORE; layout / favorites /
# modes / channel re-inserts use DELETE + INSERT keyed off names so
# re-running rebuilds the seeded subset without touching unrelated
# data the user may have added by hand. Visibility / categorization
# state is left alone.
#
# Usage: ./scripts/seed-tv-test-data.sh
set -euo pipefail

cd "$(dirname "$0")/.."

DB="${JELLYBEAN_DB:-jellybean.db}"
if [[ ! -f "$DB" ]]; then
    echo "DB not found at $DB" >&2
    exit 1
fi

PROFILE_ID=1
KID_ID=2

NOW=$(date +%s)

sqlite3 "$DB" <<EOF
BEGIN;

-- 1. Tags ---------------------------------------------------------------
INSERT OR IGNORE INTO tags (name, description, sort_order, created_at, updated_at) VALUES
  ('adventure',  'Action and exploration stories',         0, $NOW, $NOW),
  ('funny',      'Comedy and lighthearted picks',          0, $NOW, $NOW),
  ('bedtime',    'Calm watches good for winding down',     0, $NOW, $NOW),
  ('spooky',     'Mildly scary or Halloween themed',       0, $NOW, $NOW),
  ('classic',    'Older / nostalgic picks',                0, $NOW, $NOW),
  ('learning',   'Educational content',                    0, $NOW, $NOW),
  ('musical',    'Songs and singalongs',                   0, $NOW, $NOW);

-- 2. Item -> tag mapping. Distribute pseudo-randomly across visible
--    items via the rowid hash so each tag gets a meaningful slice and
--    items can carry multiple tags (more interesting tag_fanout).
DELETE FROM item_tags WHERE set_by = 'seed-tv-test';

INSERT INTO item_tags (jellyfin_item_id, tag_id, set_at, set_by)
SELECT c.jellyfin_item_id, t.id, $NOW, 'seed-tv-test'
FROM categorizations c
JOIN tags t ON (
    (t.name = 'adventure' AND c.rowid % 2 = 0) OR
    (t.name = 'funny'     AND c.rowid % 3 = 0) OR
    (t.name = 'bedtime'   AND c.rowid % 5 = 1) OR
    (t.name = 'spooky'    AND c.rowid % 7 = 2) OR
    (t.name = 'classic'   AND c.rowid % 4 = 3) OR
    (t.name = 'learning'  AND c.rowid % 11 = 4) OR
    (t.name = 'musical'   AND c.rowid % 9 = 5)
)
WHERE c.profile_id = $PROFILE_ID AND c.state = 'visible';

-- 3. Favorites for the Kids kid. Grab 7 visible items deterministically
--    so re-runs pick the same set.
DELETE FROM kid_favorites WHERE kid_id = $KID_ID;

INSERT INTO kid_favorites (kid_id, jellyfin_item_id, created_at)
SELECT $KID_ID, jellyfin_item_id, $NOW
FROM categorizations
WHERE profile_id = $PROFILE_ID AND state = 'visible'
ORDER BY jellyfin_item_id
LIMIT 7;

-- 4. Time limits. Disabled so testing doesn't get locked out.
--    Defaults reflect a sane "would actually use this" config for
--    when the user flips the toggle.
INSERT INTO profile_time_limits (
    profile_id, enabled, daily_cap_minutes, refill_interval_hours,
    day_start_hour, default_show_cap_minutes, default_movie_starts,
    updated_at
) VALUES (
    $PROFILE_ID, 0, 180, 24, 6, 30, 1, $NOW
)
ON CONFLICT(profile_id) DO UPDATE SET
    daily_cap_minutes = excluded.daily_cap_minutes,
    refill_interval_hours = excluded.refill_interval_hours,
    day_start_hour = excluded.day_start_hour,
    default_show_cap_minutes = excluded.default_show_cap_minutes,
    default_movie_starts = excluded.default_movie_starts,
    updated_at = excluded.updated_at;

-- 5. Body breaks. Also disabled by default; useful template for the
--    user to flip on when they want to test the overlay.
INSERT INTO profile_body_breaks (
    profile_id, enabled, play_minutes, break_minutes,
    voice_message_template, reasons_json, updated_at
) VALUES (
    $PROFILE_ID, 0, 30, 5,
    'Time for a quick break. {reason}',
    '["Grab a sip of water.","Take a quick potty break.","Stand up and stretch.","Tidy up some toys while we wait."]',
    $NOW
)
ON CONFLICT(profile_id) DO UPDATE SET
    play_minutes = excluded.play_minutes,
    break_minutes = excluded.break_minutes,
    voice_message_template = excluded.voice_message_template,
    reasons_json = excluded.reasons_json,
    updated_at = excluded.updated_at;

-- 6. Modes. Three covering the full day; alphabetical priority means
--    Bedtime > Daytime > Evening when windows overlap. With these
--    schedules:
--      00:00-06:00 -> Bedtime  (heavy dim+warm, bedtime theme)
--      06:00-20:00 -> Daytime  (no filter, default theme)
--      20:00-23:59 -> Evening  (mild dim+warm, bedtime theme)
DELETE FROM profile_modes WHERE profile_id = $PROFILE_ID
  AND name IN ('Daytime','Evening','Bedtime');

INSERT INTO profile_modes (
    profile_id, name, schedule_days,
    schedule_start_time, schedule_end_time,
    tag_filters_json, required_tag_ids_json, time_limits_json,
    dim_percent, warm_tint_percent,
    layout_id, theme_key,
    enter_voice_message, exit_voice_message,
    created_at, updated_at
) VALUES
    ($PROFILE_ID, 'Daytime', 127, '06:00', '20:00',
     '[]', '[]', NULL,
     0, 0, NULL, 'default',
     '', '',
     $NOW, $NOW),
    ($PROFILE_ID, 'Evening', 127, '20:00', '23:59',
     '[]', '[]', NULL,
     30, 50, NULL, 'bedtime',
     'Hey kids, it''s evening time. Settle in for some calm shows.', '',
     $NOW, $NOW),
    ($PROFILE_ID, 'Bedtime', 127, '00:00', '06:00',
     '[]', '[]', NULL,
     60, 80, NULL, 'bedtime',
     'It is almost bedtime. Just one more show before we wind down.', '',
     $NOW, $NOW);

-- 7. Tag filter rules. Hide spooky stuff globally on the Default
--    profile to demo the always_hidden override. The kid will never
--    see spooky-tagged items even though they're categorized as
--    visible. Good test of M6 resolution rules.
DELETE FROM profile_tag_filters WHERE profile_id = $PROFILE_ID;

INSERT INTO profile_tag_filters (profile_id, tag_id, mode, set_at)
SELECT $PROFILE_ID, id, 'always_hidden', $NOW FROM tags WHERE name = 'spooky';

-- 8. Channel. Adventure Pack mixes the adventure + funny tags on
--    distributed_random; placeholder data for the M15 admin
--    surfaces (the kid client doesn't render channels yet).
DELETE FROM channel_items WHERE channel_id IN (
    SELECT id FROM channels WHERE profile_id = $PROFILE_ID AND name = 'Adventure Pack'
);
DELETE FROM channel_tags WHERE channel_id IN (
    SELECT id FROM channels WHERE profile_id = $PROFILE_ID AND name = 'Adventure Pack'
);
DELETE FROM channels WHERE profile_id = $PROFILE_ID AND name = 'Adventure Pack';

INSERT INTO channels (profile_id, name, description, badge_text, badge_color, sort_order, created_at, updated_at)
VALUES ($PROFILE_ID, 'Adventure Pack', 'Action picks shuffled across the day', 'AP', '#7c5cff', 'distributed_random', $NOW, $NOW);

INSERT INTO channel_tags (channel_id, tag_id)
SELECT (SELECT id FROM channels WHERE profile_id = $PROFILE_ID AND name = 'Adventure Pack'), t.id
FROM tags t WHERE t.name IN ('adventure', 'funny');

COMMIT;

-- Summary ---------------------------------------------------------------
SELECT 'tags                ' AS metric, COUNT(*) AS n FROM tags;
SELECT 'item_tags           ', COUNT(*) FROM item_tags;
SELECT 'kid_favorites       ', COUNT(*) FROM kid_favorites WHERE kid_id = $KID_ID;
SELECT 'profile_modes       ', COUNT(*) FROM profile_modes WHERE profile_id = $PROFILE_ID;
SELECT 'profile_tag_filters ', COUNT(*) FROM profile_tag_filters WHERE profile_id = $PROFILE_ID;
SELECT 'channels            ', COUNT(*) FROM channels WHERE profile_id = $PROFILE_ID;
EOF

echo
echo "Seed complete. Restart the daemon (./scripts/jb restart) so any"
echo "in-memory caches (layout_row_cache) refresh."

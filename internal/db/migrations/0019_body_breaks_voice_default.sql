-- Body-breaks voice template + reasons grammar fix. The original
-- defaults were "Time to take a break. How about some {reason}?"
-- which produced "How about some a glass of water?" - awkward.
-- Rewrite both so the rendered sentence is natural, and migrate
-- already-saved rows that still match the old defaults so users
-- who never customised them get the fix automatically.
--
-- Profiles that have customised either field are left alone (their
-- string won't match the old default).

UPDATE profile_body_breaks
   SET voice_message_template = 'Time for a break. {reason}'
 WHERE voice_message_template = 'Time to take a break. How about some {reason}?';

UPDATE profile_body_breaks
   SET reasons_json = '["Go grab a glass of water.","Stand up and stretch.","Take a quick bathroom break.","Grab a healthy snack."]'
 WHERE reasons_json = '["water","stretching","a bathroom break","a snack"]';

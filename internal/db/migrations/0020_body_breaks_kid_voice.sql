-- Update the body-breaks default voice template + reasons to the
-- kid-friendly phrasing the user landed on. Migrate any rows still
-- holding the previous defaults; rows the admin has customised
-- away from the old defaults are left alone.

UPDATE profile_body_breaks
   SET voice_message_template = 'Time for a break! {reason}'
 WHERE voice_message_template = 'Time for a break. {reason}';

UPDATE profile_body_breaks
   SET reasons_json = '["Do you need some water?","Now is a good time to try the potty.","Move your body, do a dance!","Can we clean up our toys while we wait?"]'
 WHERE reasons_json = '["Go grab a glass of water.","Stand up and stretch.","Take a quick bathroom break.","Grab a healthy snack."]';

-- Body breaks: normalize voice template + reasons to consistent
-- imperative phrasing. Migrate any rows still on the previous two
-- defaults; rows the admin has customised away from those are left
-- alone.

UPDATE profile_body_breaks
   SET voice_message_template = 'Time for a quick break. {reason}'
 WHERE voice_message_template IN (
        'Time for a break! {reason}',
        'Time for a break. {reason}'
       );

UPDATE profile_body_breaks
   SET reasons_json = '["Grab a sip of water.","Take a quick potty break.","Stand up and stretch.","Tidy up some toys while we wait."]'
 WHERE reasons_json IN (
        '["Do you need some water?","Now is a good time to try the potty.","Move your body, do a dance!","Can we clean up our toys while we wait?"]',
        '["Go grab a glass of water.","Stand up and stretch.","Take a quick bathroom break.","Grab a healthy snack."]'
       );

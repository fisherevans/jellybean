-- Profiles get an age range so the kid-client view can filter content
-- to "appropriate for this kid's age band" rather than the binary kid /
-- adult split. Default range is 0..18 = "any kid-safe content" so the
-- existing Default profile keeps showing everything until the parent
-- explicitly narrows it.

ALTER TABLE profiles ADD COLUMN min_age INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN max_age INTEGER NOT NULL DEFAULT 18;

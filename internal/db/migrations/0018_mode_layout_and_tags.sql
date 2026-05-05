-- M13 follow-up: modes can now override the layout used during the
-- window (default = profile's layout) and add required-tag filters
-- (items must carry one of the listed tags to be visible during the
-- mode; empty list = no extra tag requirement).

ALTER TABLE profile_modes ADD COLUMN layout_id INTEGER REFERENCES layouts(id) ON DELETE SET NULL;
ALTER TABLE profile_modes ADD COLUMN required_tag_ids_json TEXT NOT NULL DEFAULT '[]';

-- Profiles get a default audio language so the curation UI can flag items
-- in other languages as likely-hide candidates. Stored as ISO 639-3
-- (3-letter) since that's what Jellyfin's MediaStreams.Language uses.

ALTER TABLE profiles ADD COLUMN default_language TEXT NOT NULL DEFAULT 'eng';

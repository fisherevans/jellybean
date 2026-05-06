-- Tags can carry an optional Phosphor icon name. The kid client
-- renders this in white next to the row title for tag rows on Browse,
-- analogous to the heart on the Favorites row. NULL = no icon.
--
-- Stored as the bare Phosphor name (e.g. "Star", "Sparkle"); the
-- admin + kid clients share a curated allow-list of supported names.
ALTER TABLE tags ADD COLUMN icon TEXT;

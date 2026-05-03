-- Replace the binary kid/adult category with a numeric minimum age so the
-- curation UI can express granularity ("good for a 3-year-old" vs "good for
-- a 13-year-old"). Existing rows are migrated:
--
--   'kid'           -> min_age = 7  (default kid bucket)
--   'adult'         -> min_age = 18
--   'uncategorized' -> min_age = NULL
--
-- min_age is one of the standard tiers {2, 5, 7, 13, 18} but the schema
-- doesn't enforce a CHECK so we can add new tiers without a schema change.

ALTER TABLE categorizations ADD COLUMN min_age INTEGER;

UPDATE categorizations
SET min_age = CASE category
    WHEN 'kid'   THEN 7
    WHEN 'adult' THEN 18
    ELSE NULL
END;

-- The 0001 migration created categorizations_category over the column we
-- are about to drop. Drop the index first; SQLite refuses DROP COLUMN
-- otherwise.
DROP INDEX IF EXISTS categorizations_category;

-- SQLite 3.35+ supports DROP COLUMN. modernc.org/sqlite ships with a
-- newer SQLite that supports this; if the target environment is older we
-- can rebuild the table instead.
ALTER TABLE categorizations DROP COLUMN category;

CREATE INDEX categorizations_min_age ON categorizations(min_age);

-- Migrate the history table the same way: rename the from/to category
-- columns to from_min_age / to_min_age. Categorical -> numeric mapping
-- matches the categorizations table.

ALTER TABLE categorization_history ADD COLUMN from_min_age INTEGER;
ALTER TABLE categorization_history ADD COLUMN to_min_age INTEGER;

UPDATE categorization_history
SET from_min_age = CASE from_category
    WHEN 'kid'   THEN 7
    WHEN 'adult' THEN 18
    WHEN 'uncategorized' THEN NULL
    ELSE NULL
END,
    to_min_age = CASE to_category
    WHEN 'kid'   THEN 7
    WHEN 'adult' THEN 18
    WHEN 'uncategorized' THEN NULL
    ELSE NULL
END;

ALTER TABLE categorization_history DROP COLUMN from_category;
ALTER TABLE categorization_history DROP COLUMN to_category;

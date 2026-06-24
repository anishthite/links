-- Tags become a first-class field on notes (independent of #hashtags in prose).
-- See implementation-notes/2026-06-02-tags-standalone.html#D-001.
--
-- tags_updated_at tracks tag mutations separately from updated_at so that
-- tag-only edits do NOT reshuffle the board's reverse-chrono sort (D-002).
-- Nullable; older rows leave it NULL (treated as "never mutated since the
-- big bang"). The backfill script populates it to mirror updated_at at the
-- time of backfill.

ALTER TABLE notes ADD COLUMN tags_updated_at INTEGER;

-- Cheap lookup for "tags changed since X" — used by the rename/delete endpoints
-- only at this point but trivial to maintain.
CREATE INDEX IF NOT EXISTS idx_notes_tags_updated_at ON notes(tags_updated_at);

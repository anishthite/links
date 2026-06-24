-- Initial schema for the board.
-- D-024: hand-written for v0; drizzle-kit added when schema starts to evolve.

CREATE TABLE IF NOT EXISTS notes (
  uuid          TEXT PRIMARY KEY,                  -- short-uuid (base58, 22 chars), generated everywhere
  text          TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',        -- JSON array as string
  color         TEXT,                              -- nullable; null → derive from primary tag
  position_x    REAL,                              -- reserved for drag-to-reorder
  position_y    REAL,
  z_index       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,                  -- epoch ms
  updated_at    INTEGER NOT NULL,                  -- epoch ms
  -- sha256(normalized text), 22 hex chars. Populated by importers so re-runs
  -- and cross-source imports dedupe automatically via the UNIQUE constraint
  -- below. Nullable so the public POST /api/notes path doesn't have to
  -- compute it (free creation, no dedup) — see D-009.
  content_hash  TEXT UNIQUE
);

-- Reverse-chrono is the only sort we currently use. Index speeds up GET /api/notes.
CREATE INDEX IF NOT EXISTS idx_notes_updated_at_desc ON notes(updated_at DESC);

-- Per-tag lookup is rare (filters are client-side in v0) but cheap to maintain.
-- We'll re-evaluate once the corpus grows past ~10k notes.

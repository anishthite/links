-- Phase-5 backfill: persistent classifier suggestions for the ghost-pill UI.
-- Additive only — `notes` is untouched, all suggestion state lives here.
-- Loaded by scripts/load-suggestions.ts from db/tag-suggestions-final.jsonl.
-- See implementation-notes/2026-05-28-tagging-batch.html (L-005..L-008).

CREATE TABLE IF NOT EXISTS tag_suggestions (
  uuid           TEXT PRIMARY KEY REFERENCES notes(uuid) ON DELETE CASCADE,
  suggested_tags TEXT NOT NULL,        -- JSON-encoded string[] (closed-set taxonomy + unclassifiable)
  primary_tag    TEXT NOT NULL,        -- always ∈ suggested_tags (validated in stitch)
  confidence     TEXT NOT NULL,        -- 'high' | 'medium' | 'low'
  rationale      TEXT,                 -- short worker-emitted justification (nullable; legacy rows may lack it)
  applied_at     INTEGER,              -- epoch ms; set when user accepts → merge into notes.tags. NULL = pending.
  created_at     INTEGER NOT NULL      -- epoch ms; when the suggestion landed in this table
);

-- Bulk-review query: "show me everything I haven't accepted yet, high-confidence first".
CREATE INDEX IF NOT EXISTS idx_tag_sugg_confidence ON tag_suggestions(confidence);
CREATE INDEX IF NOT EXISTS idx_tag_sugg_pending    ON tag_suggestions(applied_at) WHERE applied_at IS NULL;

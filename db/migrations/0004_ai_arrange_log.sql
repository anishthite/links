-- AI-arrange prompt log. Captures every POST /api/ai/arrange invocation
-- so we can iterate on the deterministic parser and (eventually) the LLM
-- path with real prompt data. Q4 from PLAN-whiteboard.md §11.
--
-- Privacy: this is a single-user board, so uuids in the affected_uuids
-- column are user-owned anyway. No PII in prompts beyond what the user
-- types. Drop or rotate at will (R-001 from implementation-notes).

CREATE TABLE IF NOT EXISTS ai_arrange_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt          TEXT    NOT NULL,
  strategy        TEXT    NOT NULL,             -- deterministic strategy name or 'llm'
  explanation     TEXT    NOT NULL,
  updates_count   INTEGER NOT NULL DEFAULT 0,
  affected_uuids  TEXT    NOT NULL DEFAULT '[]', -- JSON array; capped to first 64 uuids
  selected_uuids  TEXT,                          -- JSON array of uuids the user had selected
  status          TEXT    NOT NULL,              -- 'ok' | 'empty' | 'error'
  error_detail    TEXT,                          -- nullable; populated on status='error'
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_arrange_log_created_at ON ai_arrange_log(created_at DESC);

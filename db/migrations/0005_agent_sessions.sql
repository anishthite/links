-- Sandbox session metadata for the exe.dev-backed agent control plane.
-- First slice stores lifecycle state only; turns/artifacts land later.

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                   TEXT PRIMARY KEY,
  provider             TEXT    NOT NULL,
  provider_session_id  TEXT,
  title                TEXT,
  status               TEXT    NOT NULL,
  owner_email          TEXT    NOT NULL,
  preview_url          TEXT,
  cwd                  TEXT,
  error_message        TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner_updated
  ON agent_sessions(owner_email, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_status_updated
  ON agent_sessions(status, updated_at DESC);

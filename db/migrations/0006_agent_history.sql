-- Append-only agent transcript, event, and artifact storage.

CREATE TABLE IF NOT EXISTS agent_turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT    NOT NULL, -- 'user' | 'assistant' | 'system'
  kind        TEXT    NOT NULL, -- 'message' | 'status' | 'error' | 'summary'
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turns_session_seq
  ON agent_turns(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_turns_session_created
  ON agent_turns(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  turn_id       INTEGER REFERENCES agent_turns(id) ON DELETE SET NULL,
  seq           INTEGER NOT NULL,
  type          TEXT    NOT NULL,
  name          TEXT,
  payload_json  TEXT    NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_session_seq
  ON agent_events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_events_turn
  ON agent_events(turn_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT    NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  turn_id        INTEGER REFERENCES agent_turns(id) ON DELETE SET NULL,
  kind           TEXT    NOT NULL,
  path_or_key    TEXT,
  title          TEXT,
  content_text   TEXT,
  metadata_json  TEXT    NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_artifacts_session_created
  ON agent_artifacts(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_artifacts_turn
  ON agent_artifacts(turn_id, created_at ASC);

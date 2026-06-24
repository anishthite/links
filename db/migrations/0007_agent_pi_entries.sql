-- pi session cross-reference and full-fidelity JSONL mirror.
-- pi's JSONL session remains canonical inside the VM; D1 mirrors entries for UI/search.

ALTER TABLE agent_sessions ADD COLUMN pi_session_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN pi_session_file TEXT;
ALTER TABLE agent_sessions ADD COLUMN pi_cwd TEXT;
ALTER TABLE agent_sessions ADD COLUMN pi_leaf_entry_id TEXT;

ALTER TABLE agent_turns ADD COLUMN pi_entry_id TEXT;
ALTER TABLE agent_turns ADD COLUMN pi_parent_entry_id TEXT;
ALTER TABLE agent_turns ADD COLUMN pi_message_role TEXT;
ALTER TABLE agent_turns ADD COLUMN raw_message_json TEXT;

ALTER TABLE agent_events ADD COLUMN pi_entry_id TEXT;
ALTER TABLE agent_events ADD COLUMN pi_parent_entry_id TEXT;
ALTER TABLE agent_events ADD COLUMN tool_call_id TEXT;
ALTER TABLE agent_events ADD COLUMN raw_entry_json TEXT;

CREATE TABLE IF NOT EXISTS agent_pi_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT    NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  pi_entry_id     TEXT    NOT NULL,
  pi_parent_id    TEXT,
  pi_type         TEXT    NOT NULL,
  pi_timestamp    TEXT    NOT NULL,
  role            TEXT,
  tool_call_id    TEXT,
  raw_json        TEXT    NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_pi_entries_session_entry
  ON agent_pi_entries(session_id, pi_entry_id);
CREATE INDEX IF NOT EXISTS idx_agent_pi_entries_session_timestamp
  ON agent_pi_entries(session_id, pi_timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_agent_pi_entries_parent
  ON agent_pi_entries(session_id, pi_parent_id);
CREATE INDEX IF NOT EXISTS idx_agent_pi_entries_role
  ON agent_pi_entries(session_id, role);

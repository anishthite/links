-- UI-rotated sandbox agent secrets. Values are never returned by API responses.

CREATE TABLE IF NOT EXISTS agent_secrets (
  owner_email TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  value_json  TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (owner_email, key)
);

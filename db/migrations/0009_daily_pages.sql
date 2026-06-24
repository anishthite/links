-- One generated briefing page per local calendar day.

CREATE TABLE IF NOT EXISTS daily_pages (
  local_date   TEXT PRIMARY KEY,
  timezone     TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  content_json TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_pages_created_at
  ON daily_pages(created_at DESC);

CREATE TABLE IF NOT EXISTS wiki_pages (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topic', 'project', 'person', 'pattern', 'synthesis')),
  content_md TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  related_slugs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wiki_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  page_slug TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_updated_at ON wiki_pages(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_kind ON wiki_pages(kind);
CREATE INDEX IF NOT EXISTS idx_wiki_events_created_at ON wiki_events(created_at DESC);

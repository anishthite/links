ALTER TABLE notes ADD COLUMN source_url TEXT;
ALTER TABLE notes ADD COLUMN source_url_normalized TEXT;
ALTER TABLE notes ADD COLUMN source_title TEXT;
ALTER TABLE notes ADD COLUMN source_description TEXT;
ALTER TABLE notes ADD COLUMN source_site_name TEXT;
ALTER TABLE notes ADD COLUMN source_author TEXT;
ALTER TABLE notes ADD COLUMN source_published_at INTEGER;
ALTER TABLE notes ADD COLUMN source_fetched_at INTEGER;
ALTER TABLE notes ADD COLUMN source_content_text TEXT;
ALTER TABLE notes ADD COLUMN source_content_markdown TEXT;
ALTER TABLE notes ADD COLUMN source_status TEXT;
ALTER TABLE notes ADD COLUMN source_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_notes_source_url_normalized ON notes(source_url_normalized);
CREATE INDEX IF NOT EXISTS idx_notes_source_status ON notes(source_status);

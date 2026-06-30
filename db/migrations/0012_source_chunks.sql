ALTER TABLE notes ADD COLUMN source_final_url TEXT;
ALTER TABLE notes ADD COLUMN source_extractor TEXT;
ALTER TABLE notes ADD COLUMN source_status_code INTEGER;
ALTER TABLE notes ADD COLUMN source_content_length INTEGER;
ALTER TABLE notes ADD COLUMN source_content_truncated INTEGER;

CREATE TABLE IF NOT EXISTS note_source_chunks (
  note_uuid TEXT NOT NULL REFERENCES notes(uuid) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  heading TEXT,
  text TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_uuid, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_note_source_chunks_note_uuid ON note_source_chunks(note_uuid);

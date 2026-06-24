// Shared content-hash for importer dedup.
//
// Same text → same hash → UNIQUE constraint on notes.content_hash makes
// INSERT OR IGNORE collapse duplicates within-source, cross-source, and
// across re-runs. The uuid PK itself is a freshly-generated short-uuid —
// keeping a single uuid scheme across the API and every importer (D-009).
//
// Normalization is intentionally conservative — only fold CRLF and trim
// trailing whitespace. Case, internal whitespace, and punctuation are
// preserved. The goal is "the *same bytes stored* yield the same hash",
// not fuzzy semantic dedup.

import { createHash } from 'node:crypto';

/**
 * 22-char hex SHA-256 prefix of the normalized text.
 * 88 bits of entropy → collision probability is effectively zero at any
 * realistic personal-note volume.
 */
export function contentHash(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trimEnd();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 22);
}

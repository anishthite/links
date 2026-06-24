// Frozen copy of the OLD hashtag-extraction logic that used to be the source
// of truth for tag derivation server-side. Kept ONLY for:
//   1) one-shot backfill (scripts/backfill-tags-standalone.ts)
//   2) importer seeding (scripts/import-newnotes.ts, scripts/export-apple-notes.ts)
//
// Do NOT call from runtime server/client code — tags are authoritative on
// notes.tags as of 2026-06-02. See implementation-notes/2026-06-02-tags-standalone.html.

/** Extract de-duped lowercase hashtags from text. Insertion-ordered. */
export function parseHashtags(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s(])#([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[1]!.toLowerCase();
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** Remove the FIRST inline `#tag` from text (word-boundary, case-insensitive).
 *  Eats exactly one adjacent space (trailing preferred) so we don't leave
 *  "foo  bar" behind. Preserves opening parens and newline boundaries.
 *  Returns the text unchanged when no match. */
export function removeFirstHashtag(text: string, tag: string): string {
  if (!/^[a-zA-Z]/.test(tag)) return text;
  const escaped = tag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`(^|[\\s(])#${escaped}(?![a-zA-Z0-9_-])`, 'i');
  const m = re.exec(text);
  if (!m) return text;

  const leadLen = (m[1] ?? '').length;
  const leadChar = leadLen === 1 ? text[m.index] : '';
  const hashtagStart = m.index + leadLen;
  const hashtagEnd = m.index + m[0].length;
  const trailChar = text[hashtagEnd] ?? '';

  let cutStart = hashtagStart;
  let cutEnd = hashtagEnd;
  if (trailChar === ' ' || trailChar === '\t') cutEnd += 1;
  else if (leadChar === ' ' || leadChar === '\t') cutStart -= 1;

  return text.slice(0, cutStart) + text.slice(cutEnd);
}

/** One-shot transform: derive tags from `text`, strip the first occurrence of
 *  each derived `#tag` from the text. Returns the new {text, tags} pair. */
export function stripFirstHashtagsForTags(text: string, tags: string[]): string {
  let out = text;
  for (const t of tags) out = removeFirstHashtag(out, t);
  return out;
}

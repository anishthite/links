// Tag validation. Source of truth for both client and server (server imports
// from this file). The OLD hashtag-parser helpers (parseTagsFromText,
// appendTagToText) were removed when tags became a standalone field on
// notes — see implementation-notes/2026-06-02-tags-standalone.html. The
// runtime absorber (parseHashtagsFromText / absorbInlineHashtags) was
// re-introduced on 2026-06-04 to recover muscle-memory `#tag` typing —
// see implementation-notes/2026-06-04-color-regression.html and
// implementation-notes/2026-06-04-strip-absorbed-hashtags.html.
//
// Rules (D-006):
//   - Trim, lowercase (locale-aware), collapse internal whitespace runs.
//   - Allowed chars: unicode letters, unicode digits, space, '_', '-'.
//   - Must start with a letter or digit.
//   - Max length 40 chars after normalization.
//
// Per-note cap of 32 tags is enforced server-side (see server/routes/notes.ts).

const MAX_TAG_LEN = 40;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

// Shared scanner fragments. Both parseHashtagsFromText (collect) and
// removeFirstInlineHashtag (strip) MUST build their regexes from these
// constants — D-002 in 2026-06-04-strip-absorbed-hashtags.html. If the
// strip used a divergent lead/body class, the absorber could record a tag
// the strip can't then remove (silent drift between data and prose).
//
//   HASHTAG_LEAD       — boundary before `#`: start-of-string, whitespace,
//                        or `(`. Captured as group 1 so we know whether to
//                        eat the lead space later. Avoids lookbehind
//                        (Safari only shipped /(?<=)/ in 16.4).
//   HASHTAG_BODY_CHAR  — continuation charset: unicode letter, digit, `_`,
//                        `-`. Mirrored in HASHTAG_TAIL_NEG so the strip
//                        won't match `#foo` inside `#foobar`.
//   HASHTAG_BODY_FIRST — first body char must be a letter/digit (not `_`
//                        or `-`) to match TAG_RE; `#_foo` is rejected.
//   HASHTAG_TAIL_NEG   — negative lookahead asserting we're at a true
//                        word boundary against the body charset.
const HASHTAG_LEAD = '(^|[\\s(])';
const HASHTAG_BODY_CHAR = '[\\p{L}\\p{N}_-]';
const HASHTAG_BODY_FIRST = '[\\p{L}\\p{N}]';
const HASHTAG_TAIL_NEG = `(?!${HASHTAG_BODY_CHAR})`;
const HASHTAG_SCAN_SOURCE = `${HASHTAG_LEAD}#(${HASHTAG_BODY_FIRST}${HASHTAG_BODY_CHAR}*)${HASHTAG_TAIL_NEG}`;

/** Normalize one user-supplied tag. Returns the canonical form, or null when
 *  the input cannot be coerced into a valid tag. */
export function normalizeTag(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let t = input.trim();
  if (t.startsWith('#')) t = t.slice(1).trim();   // tolerate "#foo" pastes
  // Collapse internal whitespace runs to a single space.
  t = t.replace(/\s+/g, ' ');
  if (!t) return null;
  t = t.toLocaleLowerCase();
  if (t.length > MAX_TAG_LEN) return null;
  if (!TAG_RE.test(t)) return null;
  return t;
}

export function isValidTag(input: unknown): boolean {
  return normalizeTag(input) !== null;
}

/** Normalize and dedupe an input list. Order = first valid occurrence.
 *  Invalid entries are silently dropped. */
export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const t = normalizeTag(raw);
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** Extract `#hashtag` tokens from free-form note text, normalized + deduped.
 *  Recognizes `#foo` when preceded by start-of-string, whitespace, or `(`.
 *  Tag chars: unicode letter, digit, `_`, `-`. Stops at the first invalid char.
 *
 *  Why this lives in runtime code despite tags being a first-class column
 *  since 4aaf592 (standalone-tags migration): users still type `#idea` in the
 *  prose out of muscle memory. Without server-side absorption those tokens
 *  silently end up in `tags=[]`, the note paints `var(--paper-2)` cream, and
 *  the board reads as 'colors are gone for new notes' (verified on 2026-06-04
 *  by inspecting the most-recent prod rows). Server unions this with the
 *  client's explicit `tags` so chip-strip selections AND typed hashtags both
 *  flow into `notes.tags`. The frozen scripts/lib/legacy-hashtag-parser.ts
 *  copy stays put for backfill/importer one-shots. */
export function parseHashtagsFromText(text: unknown): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // (?<=^|\s|\() is emulated by capturing the lead char in group 1; we only
  // accept the match when the lead is start-of-string, whitespace, or '('.
  // The tag body uses the same charset as TAG_RE so anything we collect here
  // will survive normalizeTag() without dropping.
  const re = new RegExp(HASHTAG_SCAN_SOURCE, 'gu');
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = normalizeTag(m[2]);
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** Remove the FIRST inline `#tag` occurrence from `text`, matching the same
 *  boundary semantics as parseHashtagsFromText. Whitespace rule mirrors the
 *  frozen legacy scripts/lib/legacy-hashtag-parser.ts#removeFirstHashtag
 *  (D-003 in 2026-06-02-tags-standalone.html): prefer eating a trailing
 *  single space/tab; else eat the leading one. Preserves opening parens and
 *  newline boundaries. Case-insensitive via `iu` Unicode case-folding so
 *  `#Idea` strips even though normalizeTag lowercased the captured tag.
 *  Returns the input unchanged when no match. Internal — call
 *  absorbInlineHashtags from server code, not this directly. */
function removeFirstInlineHashtag(text: string, tag: string): string {
  const escaped = tag.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');
  // Built from the SAME shared constants as HASHTAG_SCAN_SOURCE so the
  // strip can never disagree with the collect about what a tag boundary is.
  const re = new RegExp(`${HASHTAG_LEAD}#${escaped}${HASHTAG_TAIL_NEG}`, 'iu');
  const m = re.exec(text);
  if (!m) return text;
  const lead = m[1] ?? '';
  const leadLen = lead.length;
  const hashtagStart = m.index + leadLen;
  const hashtagEnd = m.index + m[0].length;
  const trailChar = text[hashtagEnd] ?? '';
  const leadChar = leadLen === 1 ? text[m.index] : '';
  let cutStart = hashtagStart;
  let cutEnd = hashtagEnd;
  if (trailChar === ' ' || trailChar === '\t') cutEnd += 1;
  else if (leadChar === ' ' || leadChar === '\t') cutStart -= 1;
  return text.slice(0, cutStart) + text.slice(cutEnd);
}

/** Absorb + strip: parse inline `#hashtags` AND return the body with the
 *  first occurrence of each absorbed `#tag` removed. Closes the litter gap
 *  left by e087ccb (which absorbed but never stripped). See
 *  implementation-notes/2026-06-04-strip-absorbed-hashtags.html.
 *
 *  Semantics:
 *    - Tag set: first-occurrence per tag, deduped, normalized — same as
 *      parseHashtagsFromText.
 *    - Strip: ONE occurrence per absorbed tag. Matches the legacy backfill
 *      / sweep semantics (D-003 in 2026-06-02-tags-standalone.html), so a
 *      user who genuinely wrote `#idea ... #idea` keeps the second token.
 *    - Empty-body fallback: if stripping would empty the body (e.g. user
 *      typed only `#idea`), return the original text. The tag is still
 *      absorbed. This keeps the POST/PATCH "text required" invariant from
 *      surprising the user after they typed real input.
 *    - Idempotent: re-running on the cleaned output is a no-op (no #tag
 *      tokens remain to absorb). */
export function absorbInlineHashtags(text: unknown): { text: string; tags: string[] } {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', tags: [] };
  }
  const tags = parseHashtagsFromText(text);
  if (tags.length === 0) return { text, tags };
  let cleaned = text;
  for (const t of tags) cleaned = removeFirstInlineHashtag(cleaned, t);
  if (cleaned.trim().length === 0 && text.trim().length > 0) return { text, tags };
  return { text: cleaned, tags };
}

/** Union two tag lists, preserving first-occurrence order across both inputs.
 *  Used server-side to merge client-supplied chip tags with hashtags parsed
 *  from prose: explicit chips win order; inline `#foo` gets appended after.
 *  Both inputs must already be normalized (call normalizeTags first). */
export function unionTagsOrdered(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of primary)   { if (!seen.has(t)) { seen.add(t); out.push(t); } }
  for (const t of secondary) { if (!seen.has(t)) { seen.add(t); out.push(t); } }
  return out;
}

/** Convenience for callers that want a union of tags across many notes. */
export function uniqueTagsFromNotes(notes: { tags: string[] }[]): string[] {
  const seen = new Set<string>();
  for (const n of notes) for (const t of n.tags) seen.add(t);
  return Array.from(seen).sort();
}

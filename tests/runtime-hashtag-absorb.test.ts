// Runtime hashtag absorption — pinned behavior for the POST/PATCH flow that
// restores typed `#tag` coloring after the 4aaf592 standalone-tags migration.
//
// Regression source: between 2026-06-03 and 2026-06-04, users typing `#idea`
// in note prose got `tags=[]` because the server stopped deriving tags from
// text. Without runtime absorption the board paints `--paper-2` cream for
// every new note and reads as "colors are gone".
//
// Contract under test:
//   - parseHashtagsFromText extracts the same shape as the frozen legacy
//     parser (start-of-string / whitespace / paren before `#`).
//   - Result is normalized through normalizeTag so weird casing or trailing
//     punctuation can't poison notes.tags downstream.
//   - unionTagsOrdered keeps explicit-chip ordering and appends inline tags
//     after, deduped.
//   - absorbInlineHashtags pairs parse+strip so the saved body loses the
//     `#tag` litter while the tag column still gets populated. See
//     implementation-notes/2026-06-04-strip-absorbed-hashtags.html.

import { describe, expect, it } from 'vitest';

import {
  absorbInlineHashtags,
  parseHashtagsFromText,
  unionTagsOrdered,
} from '../src/lib/tags';

describe('parseHashtagsFromText', () => {
  it('returns [] for non-strings, empty, and tag-less text', () => {
    expect(parseHashtagsFromText(undefined)).toEqual([]);
    expect(parseHashtagsFromText(null)).toEqual([]);
    expect(parseHashtagsFromText('')).toEqual([]);
    expect(parseHashtagsFromText('plain note, no hashtags here')).toEqual([]);
  });

  it('extracts hashtags at start, mid-sentence, after newline, after paren', () => {
    expect(parseHashtagsFromText('#idea kicks off the day'))
      .toEqual(['idea']);
    expect(parseHashtagsFromText('llm eval for music making/mixing #idea'))
      .toEqual(['idea']);
    expect(parseHashtagsFromText('first line\n#thought on second'))
      .toEqual(['thought']);
    expect(parseHashtagsFromText('(see also #link below)'))
      .toEqual(['link']);
  });

  it('lowercases and dedupes preserving first occurrence', () => {
    expect(parseHashtagsFromText('#Idea then #IDEA again #thought'))
      .toEqual(['idea', 'thought']);
  });

  it('refuses mid-word matches — `foo#bar` is not a tag', () => {
    expect(parseHashtagsFromText('issue#123 inline')).toEqual([]);
    expect(parseHashtagsFromText('a#b')).toEqual([]);
  });

  it('caps at the first invalid char (matches legacy parser shape)', () => {
    // `#idea!` stops at `!`; result is just `idea`. `#x.y` stops at `.`.
    expect(parseHashtagsFromText('#idea! great')).toEqual(['idea']);
    expect(parseHashtagsFromText('#x.y')).toEqual(['x']);
  });

  it('rejects digits-only and pure-symbol "tags" via normalizeTag', () => {
    // Tag bodies must start with a letter or digit; `_foo` would be invalid.
    expect(parseHashtagsFromText('#_foo')).toEqual([]);
    // Pure digits ARE valid under normalizeTag (TAG_RE allows \p{N}+).
    expect(parseHashtagsFromText('#42')).toEqual(['42']);
  });

  it('handles the exact prod regression case (2026-06-04)', () => {
    // The note "llm eval for music making/mixing #idea" rendered cream because
    // the new server ignored inline hashtags. After the fix, this single call
    // must return ['idea'] so resolveTags can union it into notes.tags.
    expect(parseHashtagsFromText('llm eval for music making/mixing #idea'))
      .toEqual(['idea']);
    expect(parseHashtagsFromText('ai controls my spotify via cli #ai #idea'))
      .toEqual(['ai', 'idea']);
  });
});

describe('absorbInlineHashtags', () => {
  it('strips a trailing inline #tag and absorbs it (eats the preceding space)', () => {
    expect(absorbInlineHashtags('shower thought #idea'))
      .toEqual({ text: 'shower thought', tags: ['idea'] });
  });

  it('strips a leading inline #tag and absorbs it (eats the trailing space)', () => {
    expect(absorbInlineHashtags('#work meeting at 3'))
      .toEqual({ text: 'meeting at 3', tags: ['work'] });
  });

  it('strips a mid-sentence #tag preserving exactly one boundary space', () => {
    // Trailing space wins per legacy removeFirstHashtag rule — 'a #foo b' has
    // both a lead and trail space; we eat the trail.
    expect(absorbInlineHashtags('a #foo b'))
      .toEqual({ text: 'a b', tags: ['foo'] });
  });

  it('strips multiple distinct hashtags, applied in sequence', () => {
    // 'foo #bar #baz qux' — strip #bar eats its trail space → 'foo #baz qux';
    // strip #baz eats its trail space → 'foo qux'. One space preserved.
    expect(absorbInlineHashtags('foo #bar #baz qux'))
      .toEqual({ text: 'foo qux', tags: ['bar', 'baz'] });
  });

  it('only strips the FIRST occurrence per tag (matches legacy backfill D-003)', () => {
    // User who genuinely wrote #idea twice keeps the second token. The tag
    // is still absorbed exactly once.
    expect(absorbInlineHashtags('#idea then #idea again'))
      .toEqual({ text: 'then #idea again', tags: ['idea'] });
  });

  it('case-insensitive strip — `#Idea` is removed even though tag normalizes to lowercase', () => {
    expect(absorbInlineHashtags('shower thought #Idea'))
      .toEqual({ text: 'shower thought', tags: ['idea'] });
  });

  it('does NOT touch URL fragments (no lead char of space/start/paren before #)', () => {
    // 'm' before # in '.com#section' fails the lead-boundary rule, so the
    // absorber never sees a hashtag and the body stays untouched.
    expect(absorbInlineHashtags('see https://example.com#section for details'))
      .toEqual({ text: 'see https://example.com#section for details', tags: [] });
  });

  it('does NOT touch markdown-style headers `# Title` (space between # and word)', () => {
    // The scanner requires the tag body to start immediately after `#` with
    // an alphanumeric. `# Title` has a space, so it never matches.
    expect(absorbInlineHashtags('# Title\nbody'))
      .toEqual({ text: '# Title\nbody', tags: [] });
  });

  it('falls back to original text when stripping would empty the body', () => {
    // Honors the POST/PATCH "text required" invariant: pure `#idea` keeps
    // its body so the server doesn't 400 after the user actually typed.
    // Tag still absorbed.
    expect(absorbInlineHashtags('#idea'))
      .toEqual({ text: '#idea', tags: ['idea'] });
  });

  it('returns the original text unchanged when there are no hashtags', () => {
    expect(absorbInlineHashtags('plain note, no hashtags here'))
      .toEqual({ text: 'plain note, no hashtags here', tags: [] });
  });

  it('handles non-string / empty inputs without throwing', () => {
    expect(absorbInlineHashtags(undefined)).toEqual({ text: '', tags: [] });
    expect(absorbInlineHashtags(null)).toEqual({ text: '', tags: [] });
    expect(absorbInlineHashtags('')).toEqual({ text: '', tags: [] });
  });

  it('strips the inline #tag even when the user already supplied the tag explicitly', () => {
    // Muscle-memory case: user types #idea AND has the idea chip selected.
    // Both sources agree on the tag; the prose litter still gets cleaned.
    // The strip is independent of the explicit chip list — it runs purely
    // on what parseHashtagsFromText sees in the body. The server-side
    // resolveWrite then unions explicit ∪ absorbed.
    const absorbed = absorbInlineHashtags('shower thought #idea');
    const explicit = ['idea']; // simulates a chip selection
    expect(absorbed.text).toBe('shower thought');
    expect(unionTagsOrdered(explicit, absorbed.tags)).toEqual(['idea']);
  });

  it('is idempotent — re-running on cleaned output is a no-op', () => {
    const first = absorbInlineHashtags('foo #bar #baz qux');
    const second = absorbInlineHashtags(first.text);
    expect(second).toEqual({ text: 'foo qux', tags: [] });
  });

  // -- Edge-case pins. None of these change behavior; they lock in what the
  // -- current implementation actually does so a future refactor that
  // -- silently "fixes" one of them gets caught by CI. Each matches the
  // -- legacy `removeFirstHashtag` whitespace rule (D-004), which the
  // -- runtime strip lifts unchanged. See implementation-notes/
  // -- 2026-06-04-strip-absorbed-hashtags.html for A-002..A-004.

  it('leaves trailing punctuation glued to its predecessor when stripping a hashtag', () => {
    // Pins current behavior — the strip rule prefers eating a trailing
    // space/tab and otherwise the leading one; punctuation like `.` or `,`
    // is NOT a boundary the strip is willing to consume. The body keeps
    // the comma stuck to the period. Matches legacy semantics.
    // See implementation-notes/2026-06-04-strip-absorbed-hashtags.html A-002b.
    expect(absorbInlineHashtags('thought, #idea.'))
      .toEqual({ text: 'thought,.', tags: ['idea'] });
  });

  it('leaves empty parens behind when a hashtag was the only thing inside them', () => {
    // Pins current behavior — `(` is a valid lead boundary so `#idea`
    // gets absorbed, but `)` isn't an eatable trail char so the closing
    // paren stays. Result is `()`. Matches legacy semantics.
    // See implementation-notes/2026-06-04-strip-absorbed-hashtags.html A-002b.
    expect(absorbInlineHashtags('(#idea)'))
      .toEqual({ text: '()', tags: ['idea'] });
  });

  it('leaves a blank line when a hashtag occupied its own line', () => {
    // Pins current behavior — `\n` is a valid lead but the strip only
    // eats spaces/tabs, never newlines. `line1\n#idea\nline2` becomes
    // `line1\n\nline2`, not `line1\nline2`. Preserves any markdown-y
    // structure the user had above/below the bare tag line.
    // See implementation-notes/2026-06-04-strip-absorbed-hashtags.html A-004.
    expect(absorbInlineHashtags('line1\n#idea\nline2'))
      .toEqual({ text: 'line1\n\nline2', tags: ['idea'] });
  });

  it('does NOT eat NBSP (U+00A0) even though it counts as a boundary', () => {
    // Pins current behavior — the lead/trail predicate `\s` recognizes
    // NBSP for scan-boundary purposes (so `a\u00a0#foo b` IS absorbed),
    // but the strip's whitespace-eater is a strict `=== ' ' || === '\t'`
    // check that excludes NBSP. So both flanking NBSPs survive. Matches
    // legacy semantics; revisit if NBSP from Apple Notes imports ever
    // becomes a real source of litter.
    // See implementation-notes/2026-06-04-strip-absorbed-hashtags.html A-003.
    expect(absorbInlineHashtags('a\u00a0#foo\u00a0b'))
      .toEqual({ text: 'a\u00a0\u00a0b', tags: ['foo'] });
  });

  it('falls back to original text when MULTIPLE tags would strip the body empty', () => {
    // Pins current behavior — the empty-body fallback (D-005) triggers on
    // the post-strip body being whitespace-only, not just on a single-tag
    // case. `#idea\n#thought` would strip to `\n` which is whitespace; the
    // absorber returns the ORIGINAL text untouched, but BOTH tags are still
    // captured. Without this, the POST/PATCH `text required` validator would
    // 400 a write the user genuinely made.
    // See implementation-notes/2026-06-04-strip-absorbed-hashtags.html D-005.
    expect(absorbInlineHashtags('#idea\n#thought'))
      .toEqual({ text: '#idea\n#thought', tags: ['idea', 'thought'] });
  });

  // The PATCH `hasText && hasTags` branch bumps tags_updated_at
  // UNCONDITIONALLY (the client opted in by sending `tags`), while the
  // `hasText only` branch bumps grow-only. Verifying that here requires a
  // route-level integration test against the Hono app + a D1 stub, which
  // would dwarf the unit-test budget. Manual trace in the parallel review
  // (Reviewer 2, trace 2) confirms the behavior; the route comment in
  // server/routes/notes.ts now documents it explicitly. Skipping the
  // automated pin here is a known gap — see
  // implementation-notes/2026-06-04-strip-absorbed-hashtags.html L-004.
});

describe('unionTagsOrdered', () => {
  it('preserves primary order, appends secondary minus dupes', () => {
    expect(unionTagsOrdered(['idea'], ['ai', 'idea']))
      .toEqual(['idea', 'ai']);
    expect(unionTagsOrdered(['ai', 'idea'], []))
      .toEqual(['ai', 'idea']);
    expect(unionTagsOrdered([], ['link']))
      .toEqual(['link']);
  });

  it('is idempotent on its own output', () => {
    const a = unionTagsOrdered(['idea'], ['ai']);
    const b = unionTagsOrdered(a, a);
    expect(b).toEqual(a);
  });
});

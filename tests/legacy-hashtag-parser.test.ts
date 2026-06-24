// Backfill correctness rests on this parser + stripper. If it drifts the
// one-shot migration silently mangles the corpus.

import { describe, expect, it } from 'vitest';

import {
  parseHashtags,
  removeFirstHashtag,
  stripFirstHashtagsForTags,
} from '../scripts/lib/legacy-hashtag-parser';

describe('parseHashtags', () => {
  it('extracts simple hashtags', () => {
    expect(parseHashtags('hello #foo world')).toEqual(['foo']);
    expect(parseHashtags('#a #b #c')).toEqual(['a', 'b', 'c']);
  });

  it('lowercases', () => {
    expect(parseHashtags('#Foo #BAR')).toEqual(['foo', 'bar']);
  });

  it('dedupes preserving first occurrence', () => {
    expect(parseHashtags('#foo #bar #foo')).toEqual(['foo', 'bar']);
  });

  it('requires a letter start', () => {
    expect(parseHashtags('#123 #foo')).toEqual(['foo']);
  });

  it('honors word boundaries (not inside emails / urls)', () => {
    expect(parseHashtags('email me at hi@example.com#foo')).toEqual([]);
  });

  it('accepts hashtags after opening paren', () => {
    expect(parseHashtags('(#foo)')).toEqual(['foo']);
  });

  it('returns [] for hashtagless text', () => {
    expect(parseHashtags('plain prose nothing to see')).toEqual([]);
  });
});

describe('removeFirstHashtag', () => {
  it('removes the first occurrence only', () => {
    expect(removeFirstHashtag('a #foo b #foo c', 'foo')).toBe('a b #foo c');
  });

  it('eats one trailing space', () => {
    expect(removeFirstHashtag('#foo bar', 'foo')).toBe('bar');
  });

  it('falls back to leading space when no trailing space', () => {
    expect(removeFirstHashtag('bar #foo', 'foo')).toBe('bar');
  });

  it('does not eat newlines', () => {
    expect(removeFirstHashtag('line1\n#foo\nline2', 'foo')).toBe('line1\n\nline2');
  });

  it('preserves an opening paren', () => {
    expect(removeFirstHashtag('(#foo)', 'foo')).toBe('()');
  });

  it('does not match a longer hashtag with the same prefix', () => {
    expect(removeFirstHashtag('#foo-bar baz', 'foo')).toBe('#foo-bar baz');
  });

  it('is case-insensitive on match', () => {
    expect(removeFirstHashtag('hello #FOO world', 'foo')).toBe('hello world');
  });

  it('returns input unchanged when no match', () => {
    expect(removeFirstHashtag('nothing here', 'foo')).toBe('nothing here');
  });
});

describe('stripFirstHashtagsForTags', () => {
  it('strips one occurrence per tag, leaves later ones', () => {
    const text = 'a #idea b #todo c #idea d';
    expect(stripFirstHashtagsForTags(text, ['idea', 'todo']))
      .toBe('a b c #idea d');
  });

  it('is idempotent for tags not present', () => {
    expect(stripFirstHashtagsForTags('a #idea b', ['todo'])).toBe('a #idea b');
  });

  it('matches parseHashtags output as a round-trip', () => {
    const text = 'plan: #shop milk and #idea sketch a thing';
    const tags = parseHashtags(text);
    const cleaned = stripFirstHashtagsForTags(text, tags);
    // Cleaned text has no hashtags left (each tag appears exactly once in this fixture).
    expect(parseHashtags(cleaned)).toEqual([]);
    expect(cleaned).toBe('plan: milk and sketch a thing');
  });
});

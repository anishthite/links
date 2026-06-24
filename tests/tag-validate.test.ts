// Validator unit tests. The contract lives in src/lib/tags.ts and is
// consumed by both client (chip-strip add input) and server (POST/PATCH
// payload sanitization). Drift here causes silent tag loss in production —
// every behavior the rest of the system relies on should have a row.

import { describe, expect, it } from 'vitest';

import { isValidTag, normalizeTag, normalizeTags } from '../src/lib/tags';

describe('normalizeTag', () => {
  it('lowercases and trims', () => {
    expect(normalizeTag('  Foo  ')).toBe('foo');
    expect(normalizeTag('IDEA')).toBe('idea');
  });

  it('strips a leading #', () => {
    expect(normalizeTag('#bar')).toBe('bar');
    expect(normalizeTag('  #BAZ ')).toBe('baz');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeTag('hot    take')).toBe('hot take');
    expect(normalizeTag('a\tb')).toBe('a b');
  });

  it('accepts unicode letters and digits', () => {
    expect(normalizeTag('café')).toBe('café');
    expect(normalizeTag('日本語')).toBe('日本語');
    expect(normalizeTag('2024')).toBe('2024');
    expect(normalizeTag('plan2026')).toBe('plan2026');
  });

  it('accepts dashes, underscores, and spaces', () => {
    expect(normalizeTag('hot-take')).toBe('hot-take');
    expect(normalizeTag('hot_take')).toBe('hot_take');
    expect(normalizeTag('reading list')).toBe('reading list');
  });

  it('rejects empty / whitespace-only', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('#')).toBeNull();
  });

  it('rejects tags that start with a separator', () => {
    expect(normalizeTag('-foo')).toBeNull();
    expect(normalizeTag('_foo')).toBeNull();
    expect(normalizeTag(' foo')).toBe('foo');   // leading space is trimmed first, this is OK
  });

  it('rejects punctuation', () => {
    expect(normalizeTag('foo!')).toBeNull();
    expect(normalizeTag('foo/bar')).toBeNull();
    expect(normalizeTag('foo.bar')).toBeNull();
    expect(normalizeTag('foo@bar')).toBeNull();
  });

  it('caps length at 40 chars', () => {
    expect(normalizeTag('a'.repeat(40))).toBe('a'.repeat(40));
    expect(normalizeTag('a'.repeat(41))).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizeTag(undefined)).toBeNull();
    expect(normalizeTag(null)).toBeNull();
    expect(normalizeTag(42)).toBeNull();
    expect(normalizeTag({})).toBeNull();
  });
});

describe('isValidTag', () => {
  it('mirrors normalizeTag', () => {
    expect(isValidTag('foo')).toBe(true);
    expect(isValidTag('   ')).toBe(false);
    expect(isValidTag('foo!')).toBe(false);
  });
});

describe('normalizeTags', () => {
  it('dedupes case-insensitively', () => {
    expect(normalizeTags(['Foo', 'foo', 'FOO'])).toEqual(['foo']);
  });

  it('drops invalid entries silently', () => {
    expect(normalizeTags(['ok', '', 'bad!', 'also ok'])).toEqual(['ok', 'also ok']);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags('foo')).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
  });

  it('preserves insertion order of first valid occurrence', () => {
    expect(normalizeTags(['b', 'a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });
});

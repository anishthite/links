// Tag rename / delete is implemented as a per-note in-memory transform; the
// server route is a thin loop around applyTagRename(). Lock in the pure
// helper before regressions reach the wire.

import { describe, expect, it } from 'vitest';

import { applyTagRename } from '../server/routes/tags';

describe('applyTagRename (rename)', () => {
  it('renames a present tag', () => {
    expect(applyTagRename(['a', 'b', 'c'], 'b', 'x')).toEqual({
      next: ['a', 'x', 'c'],
      changed: true,
    });
  });

  it('is a no-op when `from` not present', () => {
    expect(applyTagRename(['a', 'b'], 'z', 'x')).toEqual({
      next: ['a', 'b'],
      changed: false,
    });
  });

  it('collapses when target already present', () => {
    // Renaming `b` → `a` should drop `b` and leave `a` in its original slot.
    expect(applyTagRename(['a', 'b', 'c'], 'b', 'a')).toEqual({
      next: ['a', 'c'],
      changed: true,
    });
  });

  it('preserves order when `to` is new', () => {
    expect(applyTagRename(['a', 'b', 'c'], 'a', 'z')).toEqual({
      next: ['z', 'b', 'c'],
      changed: true,
    });
  });
});

describe('applyTagRename (delete via to=null)', () => {
  it('removes a present tag', () => {
    expect(applyTagRename(['a', 'b', 'c'], 'b', null)).toEqual({
      next: ['a', 'c'],
      changed: true,
    });
  });

  it('is a no-op when tag missing', () => {
    expect(applyTagRename(['a', 'b'], 'z', null)).toEqual({
      next: ['a', 'b'],
      changed: false,
    });
  });

  it('returns [] when removing the only tag', () => {
    expect(applyTagRename(['only'], 'only', null)).toEqual({
      next: [],
      changed: true,
    });
  });
});

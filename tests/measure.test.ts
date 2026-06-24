import { describe, expect, it } from 'vitest';

import { MAX_GRID_NOTE_HEIGHT, capGridNoteHeight } from '../src/lib/measure';

describe('capGridNoteHeight', () => {
  it('caps tall masonry cards to the grid max height', () => {
    expect(capGridNoteHeight(MAX_GRID_NOTE_HEIGHT - 1)).toBe(MAX_GRID_NOTE_HEIGHT - 1);
    expect(capGridNoteHeight(MAX_GRID_NOTE_HEIGHT + 120)).toBe(MAX_GRID_NOTE_HEIGHT);
  });
});

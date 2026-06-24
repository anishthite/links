// Seed-layout tests. The contract: notes with positionX/Y already set are
// untouched; notes without are placed in a deterministic grid keyed by
// createdAt asc → uuid asc.

import { describe, expect, it } from 'vitest';

import type { Note } from '../src/lib/types';
import {
  hasPosition,
  seedGridLayout,
  SEED_CELL_HEIGHT,
  SEED_CELL_WIDTH,
  SEED_GAP,
} from '../src/whiteboard/seed-layout';

function makeNote(over: Partial<Note> & Pick<Note, 'uuid' | 'createdAt'>): Note {
  return {
    uuid: over.uuid,
    text: 't',
    tags: [],
    color: null,
    createdAt: over.createdAt,
    updatedAt: over.createdAt,
    ...over,
  };
}

describe('hasPosition', () => {
  it('false for notes lacking positionX/Y', () => {
    expect(hasPosition(makeNote({ uuid: 'a', createdAt: 1 }))).toBe(false);
    expect(hasPosition(makeNote({ uuid: 'a', createdAt: 1, positionX: 0 }))).toBe(false);
    expect(hasPosition(makeNote({ uuid: 'a', createdAt: 1, positionY: 0 }))).toBe(false);
  });
  it('true once both x and y are finite numbers', () => {
    expect(hasPosition(makeNote({ uuid: 'a', createdAt: 1, positionX: 0, positionY: 0 }))).toBe(true);
    expect(hasPosition(makeNote({ uuid: 'a', createdAt: 1, positionX: -100, positionY: 250 }))).toBe(true);
  });
  it('false when x or y is NaN/Infinity (regression: bad server data)', () => {
    expect(hasPosition(makeNote({ uuid: 'a', createdAt: 1, positionX: NaN, positionY: 0 }))).toBe(false);
    expect(hasPosition(makeNote({ uuid: 'a', createdAt: 1, positionX: 0, positionY: Infinity }))).toBe(false);
  });
});

describe('seedGridLayout', () => {
  it('returns [] when all notes have positions', () => {
    const notes = [
      makeNote({ uuid: 'a', createdAt: 1, positionX: 0, positionY: 0 }),
      makeNote({ uuid: 'b', createdAt: 2, positionX: 10, positionY: 20 }),
    ];
    expect(seedGridLayout(notes)).toEqual([]);
  });

  it('places unplaced notes only, leaving placed ones alone', () => {
    const notes = [
      makeNote({ uuid: 'a', createdAt: 1, positionX: 100, positionY: 100 }), // skipped
      makeNote({ uuid: 'b', createdAt: 2 }),
      makeNote({ uuid: 'c', createdAt: 3 }),
    ];
    const placements = seedGridLayout(notes);
    const uuids = placements.map(p => p.uuid).sort();
    expect(uuids).toEqual(['b', 'c']);
  });

  it('is deterministic across calls — same input produces same output', () => {
    const notes = Array.from({ length: 17 }, (_, i) =>
      makeNote({ uuid: `n${i.toString().padStart(2, '0')}`, createdAt: 1000 - i }),
    );
    const a = seedGridLayout(notes);
    const b = seedGridLayout(notes);
    expect(a).toEqual(b);
  });

  it('uses ceil(sqrt(N)) columns, centered on origin', () => {
    // 9 unplaced → ceil(sqrt(9))=3 cols × 3 rows. With recentering the grid
    // spans ± step on each axis (col 0→2, row 0→2 around centre col/row 1).
    const notes = Array.from({ length: 9 }, (_, i) =>
      makeNote({ uuid: `n${i}`, createdAt: i }),
    );
    const ps = seedGridLayout(notes);
    expect(ps).toHaveLength(9);
    const stepX = SEED_CELL_WIDTH + SEED_GAP;
    const stepY = SEED_CELL_HEIGHT + SEED_GAP;
    const maxX = Math.max(...ps.map(p => p.x));
    const minX = Math.min(...ps.map(p => p.x));
    expect(maxX).toBe(stepX);
    expect(minX).toBe(-stepX);
    const maxY = Math.max(...ps.map(p => p.y));
    const minY = Math.min(...ps.map(p => p.y));
    expect(maxY).toBe(stepY);
    expect(minY).toBe(-stepY);
    // Centre cell lands exactly on origin.
    expect(ps[4]).toMatchObject({ x: 0, y: 0 });
  });

  it('orders by createdAt ascending with uuid tiebreaker', () => {
    const notes = [
      makeNote({ uuid: 'z', createdAt: 100 }),
      makeNote({ uuid: 'a', createdAt: 100 }),  // same time, uuid earlier
      makeNote({ uuid: 'm', createdAt: 50 }),
    ];
    const ps = seedGridLayout(notes);
    // Earliest placement (index 0 → (0,0)) goes to createdAt=50 (uuid 'm').
    expect(ps[0]!.uuid).toBe('m');
    // Then uuid 'a' (earlier alphabetically with createdAt=100).
    expect(ps[1]!.uuid).toBe('a');
    expect(ps[2]!.uuid).toBe('z');
  });
});

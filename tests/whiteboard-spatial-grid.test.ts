// Spatial grid index for whiteboard notes (Q-P6 / D-Q6).
//
// Unit test for src/whiteboard/spatial-grid.ts. Verifies bucket boundaries,
// move semantics, and the queryRect visit guarantee (returns every uuid
// whose origin lies within the rect, even at bucket boundaries).

import { describe, expect, it } from 'vitest';

import { createSpatialGrid } from '../src/whiteboard/spatial-grid';

describe('SpatialGrid', () => {
  it('queryRect returns uuids whose origin lies inside the rect', () => {
    const g = createSpatialGrid(1120);
    g.insert('a', 0, 0);
    g.insert('b', 500, 500);
    g.insert('c', 2500, 2500);
    g.insert('d', -1500, -1500);
    const seen = new Set<string>();
    g.queryRect({ x: -100, y: -100, w: 1200, h: 1200 }, (u) => seen.add(u));
    expect(seen.has('a')).toBe(true);
    expect(seen.has('b')).toBe(true);
    // c is far away, but the grid is coarse — it may surface in adjacent
    // buckets due to slack expansion. The CALLER's job is to do the precise
    // AABB test; the grid is a pre-filter. We only assert the inclusion
    // contract (a and b MUST be visited), not exclusion of distant items.
  });

  it('move updates the bucket so queries reflect the new position', () => {
    const g = createSpatialGrid(1120);
    g.insert('a', 0, 0);
    const before = new Set<string>();
    g.queryRect({ x: -100, y: -100, w: 200, h: 200 }, (u) => before.add(u));
    expect(before.has('a')).toBe(true);

    g.move('a', 10_000, 10_000);
    const after = new Set<string>();
    g.queryRect({ x: -100, y: -100, w: 200, h: 200 }, (u) => after.add(u));
    expect(after.has('a')).toBe(false);

    const farRect = new Set<string>();
    g.queryRect({ x: 9_900, y: 9_900, w: 200, h: 200 }, (u) => farRect.add(u));
    expect(farRect.has('a')).toBe(true);
  });

  it('handles notes that straddle a bucket line via slack expansion', () => {
    const g = createSpatialGrid(1120);
    // A note at (1119, 0) lives in bucket (0,0); its right edge crosses into
    // bucket (1,0). A query rect at (1200, 0)+(50, 50) is entirely in bucket
    // (1,0) but the note's AABB (1119, 0)+(280, 220) still intersects it.
    g.insert('straddler', 1119, 0);
    const seen = new Set<string>();
    g.queryRect({ x: 1200, y: 0, w: 50, h: 50 }, (u) => seen.add(u));
    expect(seen.has('straddler')).toBe(true);
  });

  it('remove drops the uuid from future queries', () => {
    const g = createSpatialGrid(1120);
    g.insert('a', 0, 0);
    g.remove('a');
    const seen = new Set<string>();
    g.queryRect({ x: -100, y: -100, w: 200, h: 200 }, (u) => seen.add(u));
    expect(seen.has('a')).toBe(false);
    expect(g.size()).toBe(0);
  });

  it('size tracks distinct uuids', () => {
    const g = createSpatialGrid(1120);
    g.insert('a', 0, 0);
    g.insert('b', 100, 100);
    g.insert('a', 200, 200); // re-insert updates position, not size
    expect(g.size()).toBe(2);
    g.remove('a');
    expect(g.size()).toBe(1);
  });
});

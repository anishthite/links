// Deterministic AI-arrange parser tests. We test the pure function
// `arrangeDeterministic` directly (no D1, no HTTP). The contract under test
// is the prompt → updates mapping documented in PLAN-whiteboard.md §6.

import { describe, expect, it } from 'vitest';

import { arrangeDeterministic } from '../server/routes/ai';

type Row = Parameters<typeof arrangeDeterministic>[1][number];

function row(over: Partial<Row> & Pick<Row, 'uuid'>): Row {
  return {
    uuid: over.uuid,
    text: over.text ?? 'n',
    tags: over.tags ?? '[]',
    color: over.color ?? null,
    positionX: over.positionX ?? null,
    positionY: over.positionY ?? null,
    zIndex: over.zIndex ?? 0,
    createdAt: over.createdAt ?? 1000,
    updatedAt: over.updatedAt ?? 1000,
    tagsUpdatedAt: over.tagsUpdatedAt ?? null,
    contentHash: over.contentHash ?? null,
  } as Row;
}

const rows: Row[] = [
  row({ uuid: 'a', tags: '["idea"]',    createdAt: 100 }),
  row({ uuid: 'b', tags: '["idea"]',    createdAt: 200 }),
  row({ uuid: 'c', tags: '["recipe"]',  createdAt: 300 }),
  row({ uuid: 'd', tags: '["recipe"]',  createdAt: 400 }),
  row({ uuid: 'e', tags: '[]',          createdAt: 500 }),
];

describe('arrangeDeterministic — cluster by tag', () => {
  it('returns one update per note, grouped by primary tag', () => {
    const { updates, explanation } = arrangeDeterministic('cluster by tag', rows, []);
    expect(updates).toHaveLength(rows.length);
    expect(explanation.toLowerCase()).toContain('cluster');
    // Each group occupies a contiguous x-band; the bands are disjoint between
    // groups. Test the band invariant by comparing min/max x per tag.
    const byUuid = Object.fromEntries(updates.map(u => [u.uuid, u]));
    const ideaXs   = [byUuid.a!.x, byUuid.b!.x];
    const recipeXs = [byUuid.c!.x, byUuid.d!.x];
    const ideaMax   = Math.max(...ideaXs);
    const recipeMin = Math.min(...recipeXs);
    // Groups are stacked in size-desc then name-asc order; idea and recipe tie
    // at 2 each, then alphabetical. Either way, the two bands must not overlap.
    const bandsDisjoint = ideaMax < recipeMin || Math.max(...recipeXs) < Math.min(...ideaXs);
    expect(bandsDisjoint).toBe(true);
  });
});

describe('arrangeDeterministic — timeline', () => {
  it('lays out notes oldest-first along x=0,1,2...; y stays at 0', () => {
    const { updates } = arrangeDeterministic('build a timeline by date', rows, []);
    const inOrder = updates.slice().sort((a, b) => a.x - b.x).map(u => u.uuid);
    expect(inOrder).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(updates.every(u => u.y === 0)).toBe(true);
  });
});

describe('arrangeDeterministic — ring', () => {
  it('places notes around a circle (distance from origin roughly constant)', () => {
    const { updates } = arrangeDeterministic('arrange in a ring', rows, []);
    expect(updates).toHaveLength(rows.length);
    // Ring notes have their top-left offset by -CELL/2 so the *center* is at
    // (radius * cos, radius * sin). Recover the center and compare radii.
    const radii = updates.map(u => Math.hypot(u.x + 140, u.y + 110));
    const min = Math.min(...radii);
    const max = Math.max(...radii);
    expect(max - min).toBeLessThan(1e-6);
  });
});

describe('arrangeDeterministic — move tag to corner', () => {
  it('moves all #idea notes into the top-left quadrant', () => {
    const { updates, explanation } = arrangeDeterministic('move all #idea to top-left', rows, []);
    expect(updates).toHaveLength(2);
    expect(updates.map(u => u.uuid).sort()).toEqual(['a', 'b']);
    expect(updates.every(u => u.x < 0 && u.y < 0)).toBe(true);
    expect(explanation).toContain('idea');
  });
});

describe('arrangeDeterministic — unknown prompt', () => {
  it('returns empty updates and a guidance explanation', () => {
    const { updates, explanation } = arrangeDeterministic('hocus pocus', rows, []);
    expect(updates).toEqual([]);
    expect(explanation.toLowerCase()).toMatch(/cluster|timeline|ring|grid|scatter/);
  });
});

describe('arrangeDeterministic — scatter is deterministic', () => {
  it('same prompt + same rows → same output', () => {
    const a = arrangeDeterministic('scatter the notes', rows, []);
    const b = arrangeDeterministic('scatter the notes', rows, []);
    expect(a.updates).toEqual(b.updates);
  });

  it('scatter is keyed by uuid, not input order (reversed rows → same per-uuid positions)', () => {
    // Locks in that scatter hashes off uuid — not text, not list index. If a
    // future refactor accidentally keys off input order, this catches it.
    // (Review-finding fix: broader determinism invariant.)
    const a = arrangeDeterministic('scatter the notes', rows, []);
    const reversed = [...rows].reverse();
    const b = arrangeDeterministic('scatter the notes', reversed, []);
    const byUuidA = new Map(a.updates.map((u) => [u.uuid, { x: u.x, y: u.y }]));
    const byUuidB = new Map(b.updates.map((u) => [u.uuid, { x: u.x, y: u.y }]));
    expect(byUuidA.size).toBe(byUuidB.size);
    for (const [uuid, posA] of byUuidA) {
      const posB = byUuidB.get(uuid);
      expect(posB, `missing scatter pos for ${uuid} in reversed run`).toBeDefined();
      expect(posB).toEqual(posA);
    }
  });
});

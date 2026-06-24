// Coarse spatial grid index for whiteboard notes (Q-P6).
//
// Buckets uuids by (floor(x/bucketSize), floor(y/bucketSize)) so refresh()'s
// per-pan AABB scan goes from O(N) to O(visible). At N=5000 with a 1120px
// bucket (~4× SEED_CELL_WIDTH=280) and a 3×viewport buffer, queryRect
// touches ~9 buckets × ~16 notes/bucket ≈ 144 compares instead of 5000.
//
// Notes only span one bucket each (they're 280×220, far smaller than 1120).
// We track each uuid's (bx, by) so `move` can pop and re-insert with O(1)
// cost. The grid is gated behind localStorage.WHITEBOARD_GRID=1; when off,
// refresh() falls back to the linear iterate-all loop.

export type SpatialGrid = {
  /** Bucket size in board-space px (square buckets). */
  readonly bucketSize: number;
  insert(uuid: string, x: number, y: number): void;
  move(uuid: string, x: number, y: number): void;
  remove(uuid: string): void;
  /** Visit every uuid whose bucket overlaps the rect. May visit uuids whose
   *  actual point lies outside the rect (the caller still does the AABB
   *  test); this is a coarse pre-filter. */
  queryRect(rect: { x: number; y: number; w: number; h: number }, visit: (uuid: string) => void): void;
  /** Coarse count of uuids whose bucket overlaps the rect. Same traversal
   *  as queryRect but no per-uuid closure allocation. Used by the LOD
   *  enter/exit predicate (D-Q11) so the threshold can be visible-count
   *  aware without paying the visit overhead. */
  countInRect(rect: { x: number; y: number; w: number; h: number }): number;
  /** Number of distinct uuids currently in the grid (test helper). */
  size(): number;
  clear(): void;
};

export function createSpatialGrid(bucketSize = 1120): SpatialGrid {
  // Map<bucketKey, Set<uuid>>. Key = `${bx},${by}` (string). Set lookup
  // is O(1); we don't bother with a 2D array because the grid is sparse.
  const buckets = new Map<string, Set<string>>();
  // Map<uuid, [bx, by]> so move/remove can find the bucket without
  // re-deriving from a stale coord.
  const placement = new Map<string, [number, number]>();

  function key(bx: number, by: number): string {
    return `${bx},${by}`;
  }

  function bucketOf(x: number, y: number): [number, number] {
    return [Math.floor(x / bucketSize), Math.floor(y / bucketSize)];
  }

  function insertInto(bx: number, by: number, uuid: string): void {
    const k = key(bx, by);
    let s = buckets.get(k);
    if (!s) { s = new Set<string>(); buckets.set(k, s); }
    s.add(uuid);
  }

  function removeFrom(bx: number, by: number, uuid: string): void {
    const k = key(bx, by);
    const s = buckets.get(k);
    if (!s) return;
    s.delete(uuid);
    if (s.size === 0) buckets.delete(k);
  }

  return {
    bucketSize,
    insert(uuid, x, y) {
      const prev = placement.get(uuid);
      const [bx, by] = bucketOf(x, y);
      if (prev) {
        if (prev[0] === bx && prev[1] === by) return;
        removeFrom(prev[0], prev[1], uuid);
      }
      insertInto(bx, by, uuid);
      placement.set(uuid, [bx, by]);
    },
    move(uuid, x, y) {
      const [bx, by] = bucketOf(x, y);
      const prev = placement.get(uuid);
      if (prev) {
        if (prev[0] === bx && prev[1] === by) return;
        removeFrom(prev[0], prev[1], uuid);
      }
      insertInto(bx, by, uuid);
      placement.set(uuid, [bx, by]);
    },
    remove(uuid) {
      const prev = placement.get(uuid);
      if (!prev) return;
      removeFrom(prev[0], prev[1], uuid);
      placement.delete(uuid);
    },
    queryRect(rect, visit) {
      // Expand by one bucket on each side so notes whose origin lies
      // outside the rect but whose AABB intersects it are still visited.
      // (Note width 280 < bucket 1120; one bucket of slack covers any
      // straddling note.)
      const bx0 = Math.floor(rect.x / bucketSize) - 1;
      const by0 = Math.floor(rect.y / bucketSize) - 1;
      const bx1 = Math.floor((rect.x + rect.w) / bucketSize) + 1;
      const by1 = Math.floor((rect.y + rect.h) / bucketSize) + 1;
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let by = by0; by <= by1; by++) {
          const s = buckets.get(key(bx, by));
          if (!s) continue;
          s.forEach(visit);
        }
      }
    },
    countInRect(rect) {
      const bx0 = Math.floor(rect.x / bucketSize) - 1;
      const by0 = Math.floor(rect.y / bucketSize) - 1;
      const bx1 = Math.floor((rect.x + rect.w) / bucketSize) + 1;
      const by1 = Math.floor((rect.y + rect.h) / bucketSize) + 1;
      let count = 0;
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let by = by0; by <= by1; by++) {
          const s = buckets.get(key(bx, by));
          if (s) count += s.size;
        }
      }
      return count;
    },
    size() {
      return placement.size;
    },
    clear() {
      buckets.clear();
      placement.clear();
    },
  };
}

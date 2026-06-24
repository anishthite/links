// Initial deterministic grid layout for whiteboard notes with no persisted
// position. Sort by createdAt ascending, lay out left-to-right top-to-bottom
// in ceil(sqrt(N)) columns. Idempotent: notes that already have positionX
// AND positionY set are skipped.
//
// Design constraints:
//   - Pure function. No DOM, no fetch. Easy to unit-test.
//   - Stable order for stable output across reloads (D-006).
//   - Cell size matches the typical sticky-note tile (slightly wider than tall).
//
// See PLAN-whiteboard.md §6.4.

import type { Note } from '../lib/types';

export const SEED_CELL_WIDTH = 280;
export const SEED_CELL_HEIGHT = 220;
export const SEED_GAP = 24;

export type Placement = { uuid: string; x: number; y: number };

/** Cheap O(N) check: is there at least one note without a position? Used by
 *  refresh()'s fast-path (P2) to skip the seedGridLayout filter+sort when
 *  every note is already placed. */
export function hasAnyUnplaced(notes: readonly Note[]): boolean {
  for (let i = 0; i < notes.length; i++) {
    if (!hasPosition(notes[i]!)) return true;
  }
  return false;
}

/** Returns one Placement per note that currently lacks coordinates. Existing
 *  positions are left alone (caller does not need to re-PATCH them). */
export function seedGridLayout(
  notes: readonly Note[],
  cellW = SEED_CELL_WIDTH,
  cellH = SEED_CELL_HEIGHT,
  gap = SEED_GAP,
): Placement[] {
  // Fast-path: avoid the `notes.filter(...)` allocation when no notes are
  // unplaced (the common case after the first refresh). P2 in
  // implementation-notes/2026-06-10-whiteboard-perf.html.
  if (!hasAnyUnplaced(notes)) return [];
  const unplaced = notes.filter(n => !hasPosition(n));
  if (unplaced.length === 0) return [];

  // Deterministic order: oldest first, then uuid as tiebreaker for stability
  // when createdAt collides.
  const ordered = unplaced.slice().sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.uuid.localeCompare(b.uuid);
  });

  const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const rows = Math.ceil(ordered.length / cols);
  // Recenter the grid bbox on (0,0) so the camera (which boots at origin)
  // lands in the middle of the cloud instead of its top-left corner. Match
  // the convention used by scripts/build-semantic-layout.ts → recenter().
  const stepX = cellW + gap;
  const stepY = cellH + gap;
  const offsetX = ((cols - 1) * stepX) / 2;
  const offsetY = ((rows - 1) * stepY) / 2;
  const out: Placement[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const note = ordered[i]!;
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({
      uuid: note.uuid,
      x: col * stepX - offsetX,
      y: row * stepY - offsetY,
    });
  }
  return out;
}

/** True iff the note has both x and y. zIndex is irrelevant — a note placed
 *  at (0,0) with z=0 still counts as positioned. `Number.isFinite` rejects
 *  every non-number (incl. `null`, `undefined`, strings) without coercion,
 *  so the extra `typeof === 'number'` guards earlier here were redundant. */
export function hasPosition(note: Note): boolean {
  return Number.isFinite(note.positionX) && Number.isFinite(note.positionY);
}

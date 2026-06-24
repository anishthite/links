// Shared canvas raster pass used by both the minimap (always) and the LOD
// overlay (Q-P3, when enabled). Pulled out so the two paint loops can't drift.

import type { Camera } from './transform';
import { SEED_CELL_WIDTH, SEED_CELL_HEIGHT } from './seed-layout';

export type RasterNote = {
  readonly uuid?: string;
  readonly positionX: number | null | undefined;
  readonly positionY: number | null | undefined;
  readonly width?: number;
  readonly height?: number;
};

/**
 * Paint a flat color rect for every note that lies inside the (board-space)
 * clip rect, transformed through `transform(x, y)` into surface coords.
 *
 * Used by:
 *  - LOD overlay (Q-P3): clip = viewport-board-rect; transform = camera;
 *    fill from `getColor(note.uuid)`. Outline pass via `getOutline`.
 *  - Minimap: clip = null (paint all visible); transform = minimap scale+offset.
 */
export function paintNoteRects<N extends RasterNote>(
  ctx: CanvasRenderingContext2D,
  iter: Iterable<N>,
  transform: (bx: number, by: number) => { sx: number; sy: number; sw: number; sh: number; w: number; h: number },
  getColor: (note: N) => string,
  clip: { x: number; y: number; w: number; h: number } | null,
  getOutline?: (note: N) => string | null,
): void {
  for (const n of iter) {
    const x = n.positionX;
    const y = n.positionY;
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const w = n.width ?? SEED_CELL_WIDTH;
    const h = n.height ?? SEED_CELL_HEIGHT;
    if (clip) {
      if (x + w < clip.x || x > clip.x + clip.w) continue;
      if (y + h < clip.y || y > clip.y + clip.h) continue;
    }
    const t = transform(x, y);
    ctx.fillStyle = getColor(n);
    ctx.fillRect(t.sx, t.sy, Math.max(1.5, t.sw), Math.max(1.5, t.sh));
    if (getOutline) {
      const outline = getOutline(n);
      if (outline) {
        ctx.strokeStyle = outline;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(t.sx, t.sy, Math.max(1.5, t.sw), Math.max(1.5, t.sh));
      }
    }
  }
}

/** Build a board-space → surface-space transform for the LOD overlay. */
export function cameraSurfaceTransform(camera: Camera, dpr: number) {
  const z = camera.zoom * dpr;
  return (bx: number, by: number) => ({
    sx: bx * z + camera.panX * dpr,
    sy: by * z + camera.panY * dpr,
    sw: SEED_CELL_WIDTH * z,
    sh: SEED_CELL_HEIGHT * z,
    w: SEED_CELL_WIDTH,
    h: SEED_CELL_HEIGHT,
  });
}

// Canvas LOD overlay (Q-P3).
//
// When the camera zoom drops below LOD_ENTER, every mounted DOM note is
// removed and a single <canvas> renders all notes as flat color rects with
// the same `noteBgFor(tags)` fill the DOM mode uses. Once the user zooms
// back past LOD_EXIT, the canvas hides and the normal DOM-mode refresh()
// re-runs. The hysteresis gap eliminates oscillation at the boundary.
//
// Hit-testing in LOD mode: the parent does an AABB scan over the same
// note list and (on a hit) calls `forceMount(uuid)` to materialize the
// DOM node so the existing drag pipeline kicks in. Outside LOD mode this
// module no-ops — all the work lives in whiteboard.ts:refresh().

import type { Note } from '../lib/types';
import type { Camera } from './transform';
import { SEED_CELL_WIDTH, SEED_CELL_HEIGHT } from './seed-layout';
import { noteBgFor } from '../lib/colors';

export const LOD_ENTER = 0.45;
export const LOD_EXIT = 0.55;
// D-Q11 (C6): hybrid LOD predicate — enter LOD also when too many notes are
// visible at the current camera (dense board at moderate zoom would queue
// thousands of mountNote calls otherwise). Hysteresis: enter > 600, exit ≤ 400.
export const LOD_COUNT_ENTER = 600;
export const LOD_COUNT_EXIT = 400;

export type LodLayer = {
  el: HTMLCanvasElement;
  /** Show the LOD canvas and hide the DOM children. */
  enable: () => void;
  /** Hide the LOD canvas. Caller is responsible for re-mounting DOM. */
  disable: () => void;
  /** Coalesce a repaint to the next rAF. */
  scheduleRepaint: () => void;
  /** Hit-test in LOD mode. Returns the topmost note uuid at (viewportX, viewportY)
   *  in viewport-local coords, or null. */
  hitTest: (vx: number, vy: number, notes: readonly Note[], camera: Camera) => string | null;
  setSize: (w: number, h: number) => void;
  destroy: () => void;
};

export type LodOpts = {
  getVisibleNotes: () => readonly Note[];
  getCamera: () => Camera;
  getSelected: () => ReadonlySet<string>;
  getTheme: () => 'light' | 'dark';
  getViewport: () => { w: number; h: number };
  /** D-Q12 (C5): optional spatial-grid query. When provided, LOD paint uses
   *  it to iterate only the visible-rect's bucket cells instead of the full
   *  note list — sub-linear at high N. The visit callback yields uuids; we
   *  hand each one to getNote() to materialize. */
  queryRect?: (
    rect: { x: number; y: number; w: number; h: number },
    visit: (uuid: string) => void,
  ) => void;
  /** D-Q12: companion to queryRect — resolves a uuid back to its Note. */
  getNote?: (uuid: string) => Note | undefined;
};

export function createLodLayer(opts: LodOpts): LodLayer {
  const canvas = document.createElement('canvas');
  canvas.className = 'whiteboard-lod';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.pointerEvents = 'none'; // hit-test goes through the canvas via the parent's pointer handler
  canvas.style.display = 'none';

  let rafId: number | null = null;
  let enabled = false;
  let lastW = 0;
  let lastH = 0;

  function setSize(w: number, h: number): void {
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    lastW = w;
    lastH = h;
  }

  function paint(): void {
    rafId = null;
    if (!enabled) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom path: no-op
    const { w, h } = opts.getViewport();
    if (w !== lastW || h !== lastH) setSize(w, h);
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const camera = opts.getCamera();
    const notes = opts.getVisibleNotes();
    const selected = opts.getSelected();

    // Board → surface (canvas pixel) transform.
    const z = camera.zoom * dpr;
    const px = camera.panX * dpr;
    const py = camera.panY * dpr;
    const sw = SEED_CELL_WIDTH * z;
    const sh = SEED_CELL_HEIGHT * z;

    // Viewport AABB in board-space (no buffer — we draw exactly what's
    // visible plus a small slack to avoid pop-in at the edges).
    const slack = SEED_CELL_WIDTH;
    const bx0 = -camera.panX / camera.zoom - slack;
    const by0 = -camera.panY / camera.zoom - slack;
    const bx1 = bx0 + w / camera.zoom + slack * 2;
    const by1 = by0 + h / camera.zoom + slack * 2;

    // Fill pass.
    const outlines: { sx: number; sy: number }[] = [];
    // D-Q12 (C5): prefer the spatial-grid traversal when wired. queryRect
    // returns uuids in bucket order; the AABB test below still filters out
    // straddlers from the slack ring. Z-order: we still iterate the
    // grid-yielded uuids in order; collisions are rare at large N so the
    // tiny ordering diff vs. notes[] is acceptable for the flat-rect view.
    const drawOne = (n: Note): void => {
      const nx = n.positionX;
      const ny = n.positionY;
      if (typeof nx !== 'number' || typeof ny !== 'number') return;
      if (nx + SEED_CELL_WIDTH < bx0 || nx > bx1) return;
      if (ny + SEED_CELL_HEIGHT < by0 || ny > by1) return;
      ctx.fillStyle = noteBgFor(n.tags);
      const sx = nx * z + px;
      const sy = ny * z + py;
      ctx.fillRect(sx, sy, Math.max(1, sw), Math.max(1, sh));
      if (selected.has(n.uuid)) outlines.push({ sx, sy });
    };
    if (opts.queryRect && opts.getNote) {
      const getNote = opts.getNote;
      opts.queryRect(
        { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 },
        (uuid) => {
          const n = getNote(uuid);
          if (n) drawOne(n);
        },
      );
    } else {
      for (let i = 0; i < notes.length; i++) drawOne(notes[i]!);
    }

    // Selection outline pass.
    if (outlines.length > 0) {
      ctx.strokeStyle = opts.getTheme() === 'dark' ? '#E55039' : '#C8503A';
      ctx.lineWidth = Math.max(1, 2 * dpr);
      for (const o of outlines) {
        ctx.strokeRect(o.sx, o.sy, Math.max(1, sw), Math.max(1, sh));
      }
    }
  }

  function scheduleRepaint(): void {
    if (rafId != null) return;
    rafId = requestAnimationFrame(paint);
  }

  function enable(): void {
    if (enabled) return;
    enabled = true;
    canvas.style.display = '';
    scheduleRepaint();
  }

  function disable(): void {
    if (!enabled) return;
    enabled = false;
    canvas.style.display = 'none';
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function hitTest(vx: number, vy: number, notes: readonly Note[], camera: Camera): string | null {
    // Convert viewport coords to board-space, then scan notes top-down
    // (later in the array = drawn later = on top).
    const bx = vx / camera.zoom - camera.panX / camera.zoom;
    const by = vy / camera.zoom - camera.panY / camera.zoom;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i]!;
      const nx = n.positionX;
      const ny = n.positionY;
      if (typeof nx !== 'number' || typeof ny !== 'number') continue;
      if (bx < nx || bx > nx + SEED_CELL_WIDTH) continue;
      if (by < ny || by > ny + SEED_CELL_HEIGHT) continue;
      return n.uuid;
    }
    return null;
  }

  function destroy(): void {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    enabled = false;
  }

  return { el: canvas, enable, disable, scheduleRepaint, hitTest, setSize, destroy };
}

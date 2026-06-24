// Minimap: tiny canvas painted in the top-right of the whiteboard. Shows
// every visible note as a rectangle plus the current viewport as a thicker
// outlined rectangle. Read-only in v1 — clicking does nothing (could pan-to
// in a follow-up).
//
// One requestAnimationFrame coalesce. Repaint is cheap (≤ a few thousand
// fillRect calls); we don't bother with virtualization.

import type { Camera } from './transform';
import { SEED_CELL_WIDTH, SEED_CELL_HEIGHT } from './seed-layout';

const MINIMAP_W = 160;
const MINIMAP_H = 110;

/**
 * Structural shape paint() reads from each minimap note. Deliberately uses
 * `positionX`/`positionY` so the whiteboard can pass `Note` references
 * directly — zero per-item allocation in the hot path. Optional `width`/
 * `height` override fall back to SEED_CELL_*. See P1 in
 * implementation-notes/2026-06-10-whiteboard-perf.html.
 */
export type MinimapNote = {
  readonly positionX: number | null | undefined;
  readonly positionY: number | null | undefined;
  readonly width?: number;
  readonly height?: number;
};

/**
 * Lazy supplier of minimap rectangles. Invoked at paint time (inside the rAF
 * callback) so callers can pass a closure over their live note list without
 * materializing a snapshot array on every scheduleMinimap() invocation (P1).
 * Must be safely invokable twice per paint — bbox and draw both iterate.
 */
export type MinimapNotesSupplier = () => Iterable<MinimapNote>;

export type Minimap = {
  el: HTMLCanvasElement;
  /** Schedule a repaint with the given state. Coalesced via rAF. */
  update: (
    notes: MinimapNotesSupplier,
    camera: Camera,
    viewportWidth: number,
    viewportHeight: number,
  ) => void;
  /** Q-P8: mark the cached content bbox dirty so the next paint recomputes
   *  it. Call from the whiteboard whenever a note's position changes or the
   *  visible-notes list changes (filter applied/cleared, seed-grid placed
   *  unplaced notes, AI arrange landed, undo/redo, drag flush). Pure camera
   *  ticks (pan/zoom) keep the cache hot. */
  invalidateContent: () => void;
  /** Drop pending rAF. Call before removing the canvas from the DOM. */
  destroy: () => void;
};

/** Pure helper: compute the minimap bbox+scale+offset given a notes-supplier
 *  and a viewport. Exported for tests/microbench (P12) — see
 *  tests/whiteboard-perf.test.ts. Does not touch the canvas. Returns null if
 *  the combined (notes ∪ viewport) AABB is degenerate (no notes + no
 *  viewport). */
export function computeMinimapGeometry(
  supplier: MinimapNotesSupplier,
  camera: Camera,
  vw: number,
  vh: number,
): {
  minX: number; minY: number; maxX: number; maxY: number;
  scale: number; offsetX: number; offsetY: number;
} | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of supplier()) {
    const x = n.positionX;
    const y = n.positionY;
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const w = n.width ?? SEED_CELL_WIDTH;
    const h = n.height ?? SEED_CELL_HEIGHT;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  // viewport rect in board-space
  const vbX = -camera.panX / camera.zoom;
  const vbY = -camera.panY / camera.zoom;
  const vbW = vw / camera.zoom;
  const vbH = vh / camera.zoom;
  if (vbX < minX) minX = vbX;
  if (vbY < minY) minY = vbY;
  if (vbX + vbW > maxX) maxX = vbX + vbW;
  if (vbY + vbH > maxY) maxY = vbY + vbH;
  if (!Number.isFinite(minX)) return null;
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const pad = 6;
  const scale = Math.min(
    (MINIMAP_W - pad * 2) / contentW,
    (MINIMAP_H - pad * 2) / contentH,
  );
  const offsetX = pad - minX * scale + ((MINIMAP_W - pad * 2) - contentW * scale) / 2;
  const offsetY = pad - minY * scale + ((MINIMAP_H - pad * 2) - contentH * scale) / 2;
  return { minX, minY, maxX, maxY, scale, offsetX, offsetY };
}

export function createMinimap(themeOrGetter: ('light' | 'dark') | (() => 'light' | 'dark')): Minimap {
  const getTheme: () => 'light' | 'dark' =
    typeof themeOrGetter === 'function' ? themeOrGetter : () => themeOrGetter;
  const el = document.createElement('canvas');
  el.className = 'whiteboard-minimap';
  el.width = MINIMAP_W * devicePixelRatio;
  el.height = MINIMAP_H * devicePixelRatio;
  el.style.width = `${MINIMAP_W}px`;
  el.style.height = `${MINIMAP_H}px`;

  let rafId: number | null = null;
  let pendingState: {
    supplier: MinimapNotesSupplier;
    camera: Camera;
    vw: number;
    vh: number;
  } | null = null;

  // Q-P8: cached content bbox. Recomputed only when contentDirty is true.
  // Pure-pan paints reuse the cache: the only piece that depends on camera
  // is the viewport rectangle, which is unioned in at paint time.
  let contentDirty = true;
  let cachedBbox: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

  // D-Q13 (C7): cache the content (background + note rects) on an offscreen
  // canvas and rate-limit its refresh to ~20 Hz. The camera marker still
  // draws at the full incoming rate; we just drawImage() the cached content
  // underneath. Steady-state cost per paint: one drawImage + one strokeRect.
  const CONTENT_PAINT_MIN_MS = 50;
  let lastContentPaintAt = -Infinity;
  let trailingRaf: number | null = null;
  let contentBuffer: HTMLCanvasElement | null = null;
  let contentBufferCtx: CanvasRenderingContext2D | null = null;
  let contentBufferGeom: { scale: number; offsetX: number; offsetY: number } | null = null;
  let bufferUnsupported = false;
  function ensureBuffer(mainCtx: CanvasRenderingContext2D): boolean {
    if (bufferUnsupported) return false;
    if (contentBuffer && contentBufferCtx) return true;
    try {
      // Feature-detect drawImage on the MAIN context. In jsdom (and any
      // spy-based test fixture) getContext returns a stub that lacks
      // drawImage; without this guard the cached-blit path would throw.
      if (typeof (mainCtx as { drawImage?: unknown }).drawImage !== 'function') {
        bufferUnsupported = true;
        return false;
      }
      const buf = document.createElement('canvas');
      buf.width = el.width;
      buf.height = el.height;
      const bctx = buf.getContext('2d');
      if (!bctx) {
        bufferUnsupported = true;
        return false;
      }
      contentBuffer = buf;
      contentBufferCtx = bctx;
      return true;
    } catch {
      bufferUnsupported = true;
      return false;
    }
  }

  function paint(): void {
    rafId = null;
    if (!pendingState) return;
    const { supplier, camera, vw, vh } = pendingState;
    pendingState = null;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const dpr = devicePixelRatio;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = themeColors(getTheme());

    if (contentDirty || !cachedBbox) {
      cachedBbox = computeContentBbox(supplier);
      contentDirty = false;
    }
    const geom = geometryFromBboxAndCamera(cachedBbox, camera, vw, vh);
    if (!geom) return;
    const { scale, offsetX, offsetY } = geom;

    const now = performance.now();
    const throttle = now - lastContentPaintAt < CONTENT_PAINT_MIN_MS;
    const geomChanged =
      !contentBufferGeom ||
      contentBufferGeom.scale !== scale ||
      contentBufferGeom.offsetX !== offsetX ||
      contentBufferGeom.offsetY !== offsetY;
    const needContentRefresh = !throttle || geomChanged || !contentBufferGeom;

    if (needContentRefresh) {
      // Full content pass into the offscreen buffer (or directly into ctx if
      // the buffer isn't available — jsdom path or older browsers).
      const useBuffer = ensureBuffer(ctx);
      const target = useBuffer && contentBufferCtx ? contentBufferCtx : ctx;
      target.setTransform(dpr, 0, 0, dpr, 0, 0);
      target.fillStyle = colors.bg;
      target.fillRect(0, 0, MINIMAP_W, MINIMAP_H);
      target.fillStyle = colors.note;
      for (const n of supplier()) {
        const nx = n.positionX;
        const ny = n.positionY;
        if (typeof nx !== 'number' || typeof ny !== 'number') continue;
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;
        const w = (n.width ?? SEED_CELL_WIDTH) * scale;
        const h = (n.height ?? SEED_CELL_HEIGHT) * scale;
        target.fillRect(nx * scale + offsetX, ny * scale + offsetY, Math.max(1.5, w), Math.max(1.5, h));
      }
      if (useBuffer && contentBuffer) {
        // Blit the buffer to the real canvas. drawImage uses surface-space.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(contentBuffer, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      contentBufferGeom = { scale, offsetX, offsetY };
      lastContentPaintAt = now;
    } else if (contentBuffer) {
      // Throttled steady-state path: blit cached buffer underneath the
      // marker, skip the per-note iteration entirely.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(contentBuffer, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (trailingRaf == null) {
        trailingRaf = requestAnimationFrame(() => {
          trailingRaf = null;
          lastContentPaintAt = -Infinity;
        });
      }
    } else {
      // Buffer unavailable + throttled: fallback to a full repaint (jsdom
      // path returns null from getContext on the buffer canvas).
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, MINIMAP_W, MINIMAP_H);
      ctx.fillStyle = colors.note;
      for (const n of supplier()) {
        const nx = n.positionX;
        const ny = n.positionY;
        if (typeof nx !== 'number' || typeof ny !== 'number') continue;
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;
        const w = (n.width ?? SEED_CELL_WIDTH) * scale;
        const h = (n.height ?? SEED_CELL_HEIGHT) * scale;
        ctx.fillRect(nx * scale + offsetX, ny * scale + offsetY, Math.max(1.5, w), Math.max(1.5, h));
      }
    }

    // Viewport rectangle — always drawn so the camera marker is at-rate.
    const vbX = -camera.panX / camera.zoom;
    const vbY = -camera.panY / camera.zoom;
    const vbW = vw / camera.zoom;
    const vbH = vh / camera.zoom;
    ctx.strokeStyle = colors.viewport;
    ctx.lineWidth = 1.25;
    ctx.strokeRect(vbX * scale + offsetX, vbY * scale + offsetY, vbW * scale, vbH * scale);
  }

  function update(
    supplier: MinimapNotesSupplier,
    camera: Camera,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    pendingState = { supplier, camera, vw: viewportWidth, vh: viewportHeight };
    if (rafId != null) return;
    rafId = requestAnimationFrame(paint);
  }

  function invalidateContent(): void {
    contentDirty = true;
    // Force a content buffer refresh on the next paint regardless of throttle.
    contentBufferGeom = null;
    lastContentPaintAt = -Infinity;
  }

  function destroy(): void {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (trailingRaf != null) {
      cancelAnimationFrame(trailingRaf);
      trailingRaf = null;
    }
    pendingState = null;
  }

  return { el, update, invalidateContent, destroy };
}

/** Q-P8: just the content (notes-only) bbox, ignoring the viewport. Cached
 *  by the Minimap closure between paints. */
function computeContentBbox(supplier: MinimapNotesSupplier): {
  minX: number; minY: number; maxX: number; maxY: number;
} | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of supplier()) {
    const x = n.positionX;
    const y = n.positionY;
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const w = n.width ?? SEED_CELL_WIDTH;
    const h = n.height ?? SEED_CELL_HEIGHT;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function geometryFromBboxAndCamera(
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null,
  camera: Camera,
  vw: number,
  vh: number,
): { minX: number; minY: number; maxX: number; maxY: number; scale: number; offsetX: number; offsetY: number } | null {
  let minX = bbox ? bbox.minX : Infinity;
  let minY = bbox ? bbox.minY : Infinity;
  let maxX = bbox ? bbox.maxX : -Infinity;
  let maxY = bbox ? bbox.maxY : -Infinity;
  const vbX = -camera.panX / camera.zoom;
  const vbY = -camera.panY / camera.zoom;
  const vbW = vw / camera.zoom;
  const vbH = vh / camera.zoom;
  if (vbX < minX) minX = vbX;
  if (vbY < minY) minY = vbY;
  if (vbX + vbW > maxX) maxX = vbX + vbW;
  if (vbY + vbH > maxY) maxY = vbY + vbH;
  if (!Number.isFinite(minX)) return null;
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const pad = 6;
  const scale = Math.min(
    (MINIMAP_W - pad * 2) / contentW,
    (MINIMAP_H - pad * 2) / contentH,
  );
  const offsetX = pad - minX * scale + ((MINIMAP_W - pad * 2) - contentW * scale) / 2;
  const offsetY = pad - minY * scale + ((MINIMAP_H - pad * 2) - contentH * scale) / 2;
  return { minX, minY, maxX, maxY, scale, offsetX, offsetY };
}

function themeColors(theme: 'light' | 'dark'): { bg: string; note: string; viewport: string } {
  if (theme === 'dark') {
    return { bg: 'rgba(31,26,20,0.92)', note: 'rgba(241,231,214,0.45)', viewport: 'rgba(210,122,58,0.85)' };
  }
  return { bg: 'rgba(255,255,255,0.92)', note: 'rgba(36,26,18,0.40)', viewport: 'rgba(180,93,31,0.85)' };
}

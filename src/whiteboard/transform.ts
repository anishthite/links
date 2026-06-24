// Pan + zoom camera state for the whiteboard view.
//
// Two coordinate spaces:
//   board-space   — where notes actually live (positionX, positionY).
//                   Origin (0,0) is the top-left of the conceptual canvas;
//                   negative coordinates are legal (canvas is infinite).
//   viewport-space — the rendered DOM viewport; (0,0) is the top-left of
//                   the .whiteboard container.
//
// One transform applied to the .whiteboard-canvas child carries the entire
// camera state:  translate(panX, panY) scale(zoom).
// Notes inside the canvas position themselves at translate(positionX, positionY)
// in unscaled board-space — the parent transform does the rest. This means
// pan/zoom is O(1) (one transform write); only drag updates a note's own
// transform.
//
// Zoom is clamped to [MIN_ZOOM, MAX_ZOOM]. Coordinates are clamped to
// [-COORD_LIMIT, +COORD_LIMIT] on writes so the canvas never grows unbounded.

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;
export const COORD_LIMIT = 1_000_000;

export type Camera = {
  panX: number;
  panY: number;
  zoom: number;
};

export const IDENTITY_CAMERA: Readonly<Camera> = { panX: 0, panY: 0, zoom: 1 };

/** Clamp a numeric value to a finite range. NaN/Infinity collapse to `fallback`. */
export function clamp(n: number, lo: number, hi: number, fallback = 0): number {
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Clamp a single coordinate to ±COORD_LIMIT. NaN/Infinity → 0. */
export function clampCoord(n: number): number {
  return clamp(n, -COORD_LIMIT, COORD_LIMIT, 0);
}

/** Clamp zoom to [MIN_ZOOM, MAX_ZOOM]. NaN/Infinity → 1. */
export function clampZoom(z: number): number {
  return clamp(z, MIN_ZOOM, MAX_ZOOM, 1);
}

/** Convert a point from viewport-space to board-space using the given camera. */
export function viewportToBoard(camera: Camera, vx: number, vy: number): { x: number; y: number } {
  return {
    x: (vx - camera.panX) / camera.zoom,
    y: (vy - camera.panY) / camera.zoom,
  };
}

/** Convert a point from board-space to viewport-space. Inverse of viewportToBoard. */
export function boardToViewport(camera: Camera, bx: number, by: number): { x: number; y: number } {
  return {
    x: bx * camera.zoom + camera.panX,
    y: by * camera.zoom + camera.panY,
  };
}

/** Zoom about a fixed viewport point (cursor or pinch midpoint).
 *  The board-space point under the cursor stays under the cursor after zoom. */
export function zoomAt(
  camera: Camera,
  viewportX: number,
  viewportY: number,
  newZoom: number,
): Camera {
  const z = clampZoom(newZoom);
  const board = viewportToBoard(camera, viewportX, viewportY);
  return {
    zoom: z,
    panX: viewportX - board.x * z,
    panY: viewportY - board.y * z,
  };
}

/** CSS transform string for the .whiteboard-canvas. */
export function cameraTransform(camera: Camera): string {
  return `translate(${camera.panX}px, ${camera.panY}px) scale(${camera.zoom})`;
}

/** Compute the smallest camera that fits every (x, y, w, h) bbox into the
 *  given viewport rectangle, with a uniform `pad` (viewport-space px) on
 *  every edge. Returns IDENTITY_CAMERA when there are no bboxes. */
export function fitCamera(
  bboxes: readonly { x: number; y: number; w: number; h: number }[],
  viewportWidth: number,
  viewportHeight: number,
  pad = 48,
): Camera {
  if (bboxes.length === 0) return { ...IDENTITY_CAMERA };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bboxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  if (contentW <= 0 || contentH <= 0) return { ...IDENTITY_CAMERA };
  const availW = Math.max(1, viewportWidth - pad * 2);
  const availH = Math.max(1, viewportHeight - pad * 2);
  const zoom = clampZoom(Math.min(availW / contentW, availH / contentH));
  // Center the content rectangle in the viewport.
  const scaledW = contentW * zoom;
  const scaledH = contentH * zoom;
  const panX = (viewportWidth - scaledW) / 2 - minX * zoom;
  const panY = (viewportHeight - scaledH) / 2 - minY * zoom;
  return { panX, panY, zoom };
}

/** Read camera from localStorage. Falls back to IDENTITY_CAMERA on any error
 *  (missing, JSON parse, NaN/Infinity, private mode, malformed shape). */
export function loadCamera(key = 'whiteboardCamera'): Camera {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...IDENTITY_CAMERA };
    const parsed = JSON.parse(raw) as Partial<Camera>;
    return {
      panX: clampCoord(parsed.panX ?? 0),
      panY: clampCoord(parsed.panY ?? 0),
      zoom: clampZoom(parsed.zoom ?? 1),
    };
  } catch {
    return { ...IDENTITY_CAMERA };
  }
}

/** Persist camera to localStorage. Silent on failure (private mode, quota). */
export function saveCamera(camera: Camera, key = 'whiteboardCamera'): void {
  try {
    localStorage.setItem(key, JSON.stringify(camera));
  } catch {
    // private mode / quota — caller doesn't care, the in-memory camera is fine.
  }
}

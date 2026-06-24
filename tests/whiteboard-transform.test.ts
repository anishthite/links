// Pure-logic tests for the whiteboard camera. No DOM, no fetch, no localStorage
// (the load/save helpers are kept out of this suite — they're trivial wrappers
// and would just exercise jsdom's localStorage shim).

import { describe, expect, it } from 'vitest';

import {
  cameraTransform,
  clamp,
  clampCoord,
  clampZoom,
  COORD_LIMIT,
  fitCamera,
  IDENTITY_CAMERA,
  MAX_ZOOM,
  MIN_ZOOM,
  boardToViewport,
  viewportToBoard,
  zoomAt,
} from '../src/whiteboard/transform';

describe('clamp helpers', () => {
  it('clamp(n, lo, hi) clamps in range and bounds out-of-range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
  it('clamp collapses NaN and Infinity to fallback', () => {
    expect(clamp(NaN, 0, 10, 7)).toBe(7);
    expect(clamp(Infinity, 0, 10, 7)).toBe(7);
    expect(clamp(-Infinity, 0, 10, 7)).toBe(7);
  });
  it('clampCoord enforces COORD_LIMIT', () => {
    expect(clampCoord(0)).toBe(0);
    expect(clampCoord(COORD_LIMIT * 2)).toBe(COORD_LIMIT);
    expect(clampCoord(-COORD_LIMIT * 2)).toBe(-COORD_LIMIT);
    expect(clampCoord(NaN)).toBe(0);
  });
  it('clampZoom enforces [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(NaN)).toBe(1);
  });
});

describe('viewportToBoard / boardToViewport are inverses', () => {
  it('round-trips the origin at identity', () => {
    const { x, y } = viewportToBoard(IDENTITY_CAMERA, 0, 0);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });
  it('round-trips a translated camera', () => {
    const cam = { panX: 100, panY: -50, zoom: 1 };
    const board = viewportToBoard(cam, 250, 0);
    const back = boardToViewport(cam, board.x, board.y);
    expect(back.x).toBeCloseTo(250);
    expect(back.y).toBeCloseTo(0);
  });
  it('round-trips at non-unit zoom', () => {
    const cam = { panX: 17, panY: 42, zoom: 2.5 };
    const board = viewportToBoard(cam, 333, 444);
    const back = boardToViewport(cam, board.x, board.y);
    expect(back.x).toBeCloseTo(333);
    expect(back.y).toBeCloseTo(444);
  });
});

describe('zoomAt', () => {
  it('keeps the board-space point under the cursor fixed', () => {
    const cam = { panX: 0, panY: 0, zoom: 1 };
    const cursor = { x: 200, y: 150 };
    const before = viewportToBoard(cam, cursor.x, cursor.y);
    const next = zoomAt(cam, cursor.x, cursor.y, 2);
    const after = viewportToBoard(next, cursor.x, cursor.y);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(next.zoom).toBeCloseTo(2);
  });
  it('clamps new zoom into [MIN_ZOOM, MAX_ZOOM]', () => {
    const cam = { panX: 0, panY: 0, zoom: 1 };
    expect(zoomAt(cam, 0, 0, 100).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(cam, 0, 0, 0).zoom).toBe(MIN_ZOOM);
  });
});

describe('cameraTransform', () => {
  it('renders a translate(...) scale(...) string', () => {
    expect(cameraTransform({ panX: 10, panY: 20, zoom: 1.5 })).toBe('translate(10px, 20px) scale(1.5)');
  });
});

describe('fitCamera', () => {
  it('returns identity when there are no boxes', () => {
    const c = fitCamera([], 800, 600);
    expect(c).toEqual({ ...IDENTITY_CAMERA });
  });
  it('produces a camera that fits a single bbox inside the viewport with padding', () => {
    const c = fitCamera([{ x: 0, y: 0, w: 400, h: 200 }], 800, 600, 50);
    // After applying the camera, the content rectangle's bounds in viewport
    // space must lie within [pad, vw-pad] / [pad, vh-pad].
    const tl = boardToViewport(c, 0, 0);
    const br = boardToViewport(c, 400, 200);
    expect(tl.x).toBeGreaterThanOrEqual(49.999);
    expect(tl.y).toBeGreaterThanOrEqual(49.999);
    expect(br.x).toBeLessThanOrEqual(800 - 50 + 0.001);
    expect(br.y).toBeLessThanOrEqual(600 - 50 + 0.001);
  });
  it('centers a tiny content rect inside the viewport', () => {
    const c = fitCamera([{ x: 0, y: 0, w: 10, h: 10 }], 800, 600, 0);
    const tl = boardToViewport(c, 0, 0);
    const br = boardToViewport(c, 10, 10);
    expect((tl.x + br.x) / 2).toBeCloseTo(400);
    expect((tl.y + br.y) / 2).toBeCloseTo(300);
  });
});

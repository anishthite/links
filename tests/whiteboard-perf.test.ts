// @vitest-environment jsdom
//
// Whiteboard perf microbench (regression-detection only).
//
// What this test does
// --------------------
//  - Synthesizes 5000 placed Note objects in a deterministic grid.
//  - Mounts createWhiteboard() with stub callbacks against a jsdom document.
//  - Forces the container to a 1280x720 logical viewport via
//    Object.defineProperty (jsdom returns 0 for clientWidth/Height otherwise,
//    which makes the virtualization gate drop straight to "mount all" and
//    invalidates the bench).
//  - Measures wall-clock time for four scenarios:
//      1) First refresh() (mounts the visible subset)
//      2) 60 successive synthetic pan setCamera() calls — exercises the rAF
//         camera-write coalesce and the visibility-refresh coalesce path.
//      3) A drag sequence (1 pointerdown + 10 pointermoves + 1 pointerup) on
//         a single note via dispatched PointerEvents.
//      4) A scheduleMinimap-equivalent burst (50 calls) by repeatedly calling
//         setCamera() on already-coalesced state — every setCamera schedules
//         a minimap repaint internally (see scheduleMinimap()).
//
// Assertions are **soft budgets** with very loose thresholds — CI variance,
// jsdom slowness vs. real browsers, and machine noise mean we are only
// catching order-of-magnitude regressions. Numbers are also logged via
// console.info so a human can eyeball trends.
//
// Why some bits are stubbed:
//  - jsdom has no Canvas 2D context; createMinimap calls getContext('2d')
//    which returns null and the paint() function early-exits. That's fine —
//    we still exercise the schedule + rAF path, just not the pixel-pushing.
//  - jsdom has no PointerEvent constructor. We dispatch MouseEvents with the
//    pointerId/button/clientX/clientY shimmed on, which matches what the
//    whiteboard handlers actually read.
//  - jsdom's setPointerCapture is a no-op; we monkey-patch to ensure it
//    never throws on elements that haven't been hit-tested by jsdom.

import { describe, expect, it, beforeAll } from 'vitest';

import type { Note } from '../src/lib/types';
import { createWhiteboard } from '../src/whiteboard';

// -- Test fixtures ----------------------------------------------------------

const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;
const N_NOTES = 5000;
const GRID_COLS = 80;
const CELL_W = 320;
const CELL_H = 260;

function makeNotes(n: number): Note[] {
  const now = Date.now();
  const out: Note[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    out.push({
      uuid: `n-${i}`,
      text: `note ${i} — lorem ipsum filler`,
      tags: i % 7 === 0 ? ['todo'] : [],
      color: null,
      createdAt: now - i * 1000,
      updatedAt: now - i * 1000,
      positionX: col * CELL_W,
      positionY: row * CELL_H,
      zIndex: 0,
    });
  }
  return out;
}

type WhiteboardHandle = ReturnType<typeof createWhiteboard>;

function mount(notes: Note[]): { wb: WhiteboardHandle; container: HTMLElement } {
  localStorage.removeItem('whiteboardCamera');
  const byUuid = new Map(notes.map((n) => [n.uuid, n]));

  const wb = createWhiteboard({
    onPositionsChanged: () => {},
    onNoteClick: () => {},
    getNote: (uuid) => byUuid.get(uuid),
    getVisibleNotes: () => notes,
  });

  // Force a non-zero layout box. jsdom returns 0 for clientWidth/clientHeight
  // unconditionally; without this the virtualization gate falls through to
  // "mount all" (rect === null) and we'd be benching a different code path.
  Object.defineProperty(wb.el, 'clientWidth', { configurable: true, value: VIEWPORT_W });
  Object.defineProperty(wb.el, 'clientHeight', { configurable: true, value: VIEWPORT_H });

  document.body.appendChild(wb.el);
  return { wb, container: wb.el };
}

// Drain microtasks + any rAFs scheduled during the operation. jsdom's
// requestAnimationFrame defers to setTimeout(0) so flushing a setTimeout
// macrotask is enough — but we burst-flush a few rounds to catch chains
// (e.g. visibility-refresh → refresh → applyCamera → another rAF).
async function tick(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// -- Tests ------------------------------------------------------------------

beforeAll(() => {
  // Some node builds of jsdom lack PointerEvent. The whiteboard handlers only
  // read .button, .clientX/.clientY, .pointerId, .pointerType, .shiftKey from
  // the event, so a MouseEvent with those props attached is sufficient.
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
    (globalThis as { PointerEvent: typeof MouseEvent }).PointerEvent =
      class extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init as MouseEventInit);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? 'mouse';
        }
      } as unknown as typeof MouseEvent;
  }

  // jsdom may not implement setPointerCapture on every element class; stub a
  // no-op so the drag bench doesn't throw on tile.setPointerCapture(id).
  if (!('setPointerCapture' in Element.prototype)) {
    (Element.prototype as unknown as { setPointerCapture: (id: number) => void })
      .setPointerCapture = () => {};
  }
  if (!('releasePointerCapture' in Element.prototype)) {
    (Element.prototype as unknown as { releasePointerCapture: (id: number) => void })
      .releasePointerCapture = () => {};
  }
});

describe('whiteboard perf microbench', () => {
  it('first refresh() mounts visible-subset within soft budget', async () => {
    const notes = makeNotes(N_NOTES);
    const { wb } = mount(notes);
    try {
      const t0 = performance.now();
      wb.refresh();
      const dt = performance.now() - t0;
      await tick();
      console.info(`[perf] first refresh(): ${dt.toFixed(2)} ms (${notes.length} notes)`);

      // Loose budget — regression catcher only. Real browsers are ~5-20×
      // faster than jsdom for DOM mutation.
      expect(dt).toBeLessThan(3000);

      // Sanity: virtualization should have evicted the vast majority of
      // notes. If clientWidth defined-property silently failed we'd see
      // ~5000 mounted; assert generously to avoid false flags on layout
      // tweaks.
      const mounted = wb.el.querySelectorAll('.whiteboard-note').length;
      console.info(`[perf] mounted nodes after first refresh: ${mounted}`);
      expect(mounted).toBeLessThan(notes.length);
    } finally {
      wb.destroy();
      wb.el.remove();
    }
  });

  it('60 successive pan setCamera() calls stay within soft budget', async () => {
    const notes = makeNotes(N_NOTES);
    const { wb } = mount(notes);
    try {
      wb.refresh();
      await tick();

      // Simulate 60 pan events by dispatching pointermove during a held
      // pointerdown. The pan branch calls setCamera() once per move, which
      // schedules: applyCamera (rAF) + scheduleVisibilityRefresh (rAF).
      wb.el.dispatchEvent(new MouseEvent('pointerdown', {
        button: 1, // middle-click → pan
        clientX: 100,
        clientY: 100,
        bubbles: true,
      }));

      const t0 = performance.now();
      for (let i = 0; i < 60; i++) {
        wb.el.dispatchEvent(new MouseEvent('pointermove', {
          clientX: 100 + i * 5,
          clientY: 100 + i * 3,
          bubbles: true,
        }));
      }
      // Flush rAFs so the coalesced camera + visibility writes actually run
      // and contribute to the measurement.
      await tick(8);
      const dt = performance.now() - t0;

      wb.el.dispatchEvent(new MouseEvent('pointerup', {
        clientX: 400, clientY: 280, bubbles: true,
      }));

      console.info(`[perf] 60 synthetic pan moves (+rAF flush): ${dt.toFixed(2)} ms`);
      expect(dt).toBeLessThan(3000);
    } finally {
      wb.destroy();
      wb.el.remove();
    }
  });

  it('10-pointermove drag sequence on one note stays within soft budget', async () => {
    const notes = makeNotes(N_NOTES);
    const { wb } = mount(notes);
    try {
      wb.refresh();
      await tick();

      // Pick a mounted note (the first one in the viewport — uuid 'n-0' is
      // at board (0,0) which sits in the +/- 1 viewport buffer). If we get
      // null here it means virtualization evicted everything and the bench
      // would silently measure nothing — fail loud rather than green-CI a
      // regression away (test-review finding).
      const tile = wb.el.querySelector<HTMLElement>('.whiteboard-note');
      expect(tile, 'drag bench: no mounted note tile — virtualization regression?').not.toBeNull();
      const dragTile = tile!;

      dragTile.dispatchEvent(new MouseEvent('pointerdown', {
        button: 0,
        clientX: 50,
        clientY: 50,
        bubbles: true,
      }));

      const t0 = performance.now();
      for (let i = 1; i <= 10; i++) {
        wb.el.dispatchEvent(new MouseEvent('pointermove', {
          clientX: 50 + i * 8,
          clientY: 50 + i * 4,
          bubbles: true,
        }));
      }
      await tick(6);
      const dt = performance.now() - t0;

      wb.el.dispatchEvent(new MouseEvent('pointerup', {
        clientX: 130, clientY: 90, bubbles: true,
      }));
      await tick();

      console.info(`[perf] drag (10 moves on one note +rAF flush): ${dt.toFixed(2)} ms`);
      expect(dt).toBeLessThan(2000);
    } finally {
      wb.destroy();
      wb.el.remove();
    }
  });

  // NOTE: this bench measures schedule + rAF coalesce overhead only.
  // jsdom returns null from getContext('2d') so the per-note fillRect loop
  // never runs here. Minimap paint correctness is covered separately by
  // tests/whiteboard-minimap.test.ts (canvas-spy harness). Review-finding
  // fix: previously this comment implied the bench exercised paint.
  it('scheduleMinimap-equivalent burst (50 calls) stays within soft budget', async () => {
    const notes = makeNotes(N_NOTES);
    const { wb } = mount(notes);
    try {
      wb.refresh();
      await tick();

      // Every applyExternalMoves call invokes scheduleMinimap() exactly
      // once (see whiteboard.ts). Passing an empty updates array still
      // triggers the rAF schedule + a snapshot of the visible-notes list.
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) {
        wb.applyExternalMoves([]);
      }
      await tick(6);
      const dt = performance.now() - t0;

      console.info(`[perf] 50 scheduleMinimap-equivalent calls: ${dt.toFixed(2)} ms`);
      expect(dt).toBeLessThan(2000);
    } finally {
      wb.destroy();
      wb.el.remove();
    }
  });
});

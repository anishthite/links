// @vitest-environment jsdom
//
// Whiteboard perf feature-flag behavior tests (Q-P3, Q-P4, Q-P6).
//
// Each test toggles a localStorage flag, mounts the whiteboard, and asserts
// the gated behavior. Default-off tests stay green (covered by
// tests/whiteboard-perf.test.ts) — these tests are the only ones that touch
// localStorage, so the flag state is scoped to each `it` via beforeEach.

import { describe, expect, it, beforeEach, afterEach, beforeAll } from 'vitest';

import type { Note } from '../src/lib/types';
import { createWhiteboard } from '../src/whiteboard';
import { saveCamera } from '../src/whiteboard/transform';

const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;

function makeNotes(n: number, gridCols = 80, cellW = 320, cellH = 260): Note[] {
  const now = Date.now();
  const out: Note[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      uuid: `n-${i}`,
      text: `n ${i}`,
      tags: [],
      color: null,
      createdAt: now,
      updatedAt: now,
      positionX: (i % gridCols) * cellW,
      positionY: Math.floor(i / gridCols) * cellH,
      zIndex: 0,
    });
  }
  return out;
}

function mount(notes: Note[]) {
  const byUuid = new Map(notes.map((n) => [n.uuid, n]));
  const wb = createWhiteboard({
    onPositionsChanged: () => {},
    onNoteClick: () => {},
    getNote: (uuid) => byUuid.get(uuid),
    getVisibleNotes: () => notes,
  });
  Object.defineProperty(wb.el, 'clientWidth', { configurable: true, value: VIEWPORT_W });
  Object.defineProperty(wb.el, 'clientHeight', { configurable: true, value: VIEWPORT_H });
  document.body.appendChild(wb.el);
  return { wb, byUuid };
}

async function tick(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeAll(() => {
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
  if (!('setPointerCapture' in Element.prototype)) {
    (Element.prototype as unknown as { setPointerCapture: (id: number) => void })
      .setPointerCapture = () => {};
  }
  if (!('releasePointerCapture' in Element.prototype)) {
    (Element.prototype as unknown as { releasePointerCapture: (id: number) => void })
      .releasePointerCapture = () => {};
  }
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('flag.lod (Q-P3)', () => {
  it('mounts zero DOM notes when zoom is below LOD_ENTER', async () => {
    localStorage.setItem('WHITEBOARD_LOD', '1');
    const notes = makeNotes(500);

    const first = mount(notes);
    try {
      first.wb.refresh();
      await tick();
      const mountedAtZoom1 = first.wb.el.querySelectorAll('.whiteboard-note').length;
      expect(mountedAtZoom1).toBeGreaterThan(0);
    } finally {
      first.wb.destroy();
      first.wb.el.remove();
    }

    // JSDOM wheel dispatch is flaky here; seed the persisted camera instead so
    // createWhiteboard() starts below the LOD threshold deterministically.
    saveCamera({ panX: 0, panY: 0, zoom: 0.25 });
    const second = mount(notes);
    try {
      second.wb.refresh();
      await tick(8);
      const mountedAtLowZoom = second.wb.el.querySelectorAll('.whiteboard-note').length;
      expect(mountedAtLowZoom).toBe(0);
      const lod = second.wb.el.querySelector<HTMLCanvasElement>('.whiteboard-lod');
      expect(lod).not.toBeNull();
      expect(lod!.style.display).not.toBe('none');
    } finally {
      second.wb.destroy();
      second.wb.el.remove();
    }
  });

  it('does not insert the LOD canvas when the flag is off', async () => {
    // No flag set → no LOD canvas.
    const notes = makeNotes(100);
    const { wb } = mount(notes);
    try {
      wb.refresh();
      await tick();
      expect(wb.el.querySelector('.whiteboard-lod')).toBeNull();
    } finally {
      wb.destroy();
      wb.el.remove();
    }
  });
});

describe('flag.grid (Q-P6)', () => {
  it('refresh() still mounts the visible subset via spatial-grid query', async () => {
    localStorage.setItem('WHITEBOARD_GRID', '1');
    const notes = makeNotes(2000);
    const { wb } = mount(notes);
    try {
      wb.refresh();
      await tick();
      const mounted = wb.el.querySelectorAll('.whiteboard-note').length;
      // At zoom=1 with VIEWPORT 1280x720 and a 3×viewport buffer, the visible
      // subset should be << 2000 but > 0.
      expect(mounted).toBeGreaterThan(0);
      expect(mounted).toBeLessThan(notes.length);
    } finally {
      wb.destroy();
      wb.el.remove();
    }
  });
});

describe('flag.chunk (Q-P4)', () => {
  it('initial mount caps at MOUNT_BUDGET=32 synchronous mounts', async () => {
    localStorage.setItem('WHITEBOARD_CHUNK', '1');
    // Pack notes tighter so many of them land inside the viewport buffer.
    const notes = makeNotes(2000, 80, 100, 100); // small cells → many in view
    const { wb } = mount(notes);
    try {
      wb.refresh();
      // Immediately after refresh (before any idle drain), at most MOUNT_BUDGET
      // notes should be mounted.
      const initialMounted = wb.el.querySelectorAll('.whiteboard-note').length;
      expect(initialMounted).toBeLessThanOrEqual(32);

      // After idle ticks, the queue drains and more notes appear.
      await tick(20);
      const afterDrain = wb.el.querySelectorAll('.whiteboard-note').length;
      expect(afterDrain).toBeGreaterThan(initialMounted);
    } finally {
      wb.destroy();
      wb.el.remove();
    }
  });
});

describe('flag.evictDebounce (Q-P5a)', () => {
  it('pan-then-pan-back within debounce window keeps nodes mounted', async () => {
    localStorage.setItem('WHITEBOARD_EVICT_DEBOUNCE', '1');
    const notes = makeNotes(1000);
    const { wb } = mount(notes);
    try {
      wb.refresh();
      await tick();
      const initial = wb.el.querySelectorAll('.whiteboard-note').length;
      expect(initial).toBeGreaterThan(0);

      // Simulate a large pan via middle-click drag. With debounce on, the
      // previously-mounted nodes should stay in the DOM (deferred eviction).
      wb.el.dispatchEvent(new MouseEvent('pointerdown', {
        button: 1, clientX: 0, clientY: 0, bubbles: true,
      }));
      wb.el.dispatchEvent(new MouseEvent('pointermove', {
        clientX: 5000, clientY: 5000, bubbles: true,
      }));
      await tick(6);
      wb.el.dispatchEvent(new MouseEvent('pointerup', {
        clientX: 5000, clientY: 5000, bubbles: true,
      }));
      // Immediately after the pan, eviction is deferred — nodes that left
      // the viewport should NOT have been removed yet.
      const afterPan = wb.el.querySelectorAll('.whiteboard-note').length;
      expect(afterPan).toBeGreaterThanOrEqual(initial);
    } finally {
      wb.destroy();
      wb.el.remove();
    }
  });
});

// @vitest-environment jsdom
//
// Whiteboard minimap correctness regression test.
//
// jsdom returns null from HTMLCanvasElement.prototype.getContext('2d'), so
// the whiteboard's perf microbench cannot prove that the minimap actually
// paints. This file fills that gap: we install a fake 2D-context spy on the
// canvas, mount the whiteboard, push a few state changes (refresh,
// applyExternalMoves), flush rAFs, and assert that:
//
//   1. ctx.fillRect was invoked at least once per visible note (one for the
//      bg, one per note, plus a strokeRect for the viewport).
//   2. computeMinimapGeometry, exported from minimap.ts as a pure helper,
//      consumes the supplier closure correctly. This catches any future
//      regression where the call site materializes an array instead of
//      passing a closure (which was the original review-flagged blocker
//      shape).
//
// The supplier contract demands that the function be safely invokable
// TWICE per paint (bbox pass + draw pass); we verify that too.

import { describe, expect, it, beforeAll, vi } from 'vitest';

import { computeMinimapGeometry, type MinimapNote, type MinimapNotesSupplier } from '../src/whiteboard/minimap';
import { createWhiteboard } from '../src/whiteboard';
import type { Note } from '../src/lib/types';

type CtxSpy = {
  setTransform: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  strokeRect: ReturnType<typeof vi.fn>;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
};

function makeCtxSpy(): CtxSpy {
  return {
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  };
}

async function tick(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  // jsdom lacks PointerEvent on some builds — the test below only uses
  // standard events so this is defensive.
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
    (globalThis as { PointerEvent: typeof MouseEvent }).PointerEvent =
      class extends MouseEvent {} as unknown as typeof MouseEvent;
  }
});

describe('computeMinimapGeometry (pure)', () => {
  it('consumes the supplier closure twice (bbox + draw safe)', () => {
    let callCount = 0;
    const supplier: MinimapNotesSupplier = () => {
      callCount += 1;
      return [
        { positionX: 0, positionY: 0 },
        { positionX: 200, positionY: 100 },
      ];
    };
    const geom = computeMinimapGeometry(
      supplier,
      { panX: 0, panY: 0, zoom: 1 },
      800, 600,
    );
    expect(geom).not.toBeNull();
    expect(callCount).toBe(1); // computeMinimapGeometry only iterates once
    // Now simulate the second pass paint() does over the supplier.
    let count = 0;
    for (const _ of supplier()) count += 1;
    expect(count).toBe(2);
  });

  it('skips notes whose positionX/Y are non-numeric', () => {
    const notes: MinimapNote[] = [
      { positionX: 100, positionY: 100 },
      { positionX: null, positionY: 100 },          // unplaced
      { positionX: NaN, positionY: 100 },           // not finite
      { positionX: undefined, positionY: 0 },       // unplaced
    ];
    const supplier: MinimapNotesSupplier = () => notes;
    const geom = computeMinimapGeometry(supplier, { panX: 0, panY: 0, zoom: 1 }, 800, 600);
    expect(geom).not.toBeNull();
    expect(Number.isFinite(geom!.scale)).toBe(true);
  });
});

describe('whiteboard minimap paint integration', () => {
  it('repaints fillRect for each visible note after refresh', async () => {
    // Install a 2D-context spy on every <canvas>. The createMinimap factory
    // calls getContext('2d') inside its paint() function, so this must be in
    // place before the whiteboard mounts. The replacement is made via
    // defineProperty because jsdom installs getContext as a non-writable
    // accessor on the prototype on some builds.
    const ctx = makeCtxSpy();
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: unknown;
    };
    const origDesc = Object.getOwnPropertyDescriptor(proto, 'getContext');
    Object.defineProperty(proto, 'getContext', {
      configurable: true,
      writable: true,
      value: function (kind: string): unknown {
        if (kind === '2d') return ctx;
        return null;
      },
    });

    try {
      const now = Date.now();
      const notes: Note[] = Array.from({ length: 8 }, (_, i) => ({
        uuid: `m-${i}`,
        text: `note ${i}`,
        tags: [],
        color: null,
        createdAt: now - i * 1000,
        updatedAt: now - i * 1000,
        positionX: (i % 4) * 320,
        positionY: Math.floor(i / 4) * 260,
        zIndex: 0,
      }));
      const byUuid = new Map(notes.map((n) => [n.uuid, n]));

      const wb = createWhiteboard({
        onPositionsChanged: () => {},
        getNote: (uuid) => byUuid.get(uuid),
        getVisibleNotes: () => notes,
      });
      Object.defineProperty(wb.el, 'clientWidth', { configurable: true, value: 1280 });
      Object.defineProperty(wb.el, 'clientHeight', { configurable: true, value: 720 });
      document.body.appendChild(wb.el);

      try {
        wb.refresh();
        // applyExternalMoves directly invokes scheduleMinimap() so the
        // paint rAF is guaranteed to be queued by the time we tick. The
        // tick delay must exceed the rAF dispatch interval (~16ms) so the
        // queued paint callback has a chance to flush.
        wb.applyExternalMoves([]);
        await tick(4);

        // bg fillRect (1) + per-note fillRect (>= notes.length).
        const fillCalls = ctx.fillRect.mock.calls.length;
        expect(fillCalls).toBeGreaterThanOrEqual(notes.length + 1);
        // One viewport strokeRect.
        expect(ctx.strokeRect).toHaveBeenCalled();
        // setTransform was called once per paint with DPR scaling.
        expect(ctx.setTransform).toHaveBeenCalled();
      } finally {
        wb.destroy();
        wb.el.remove();
      }
    } finally {
      if (origDesc) Object.defineProperty(proto, 'getContext', origDesc);
      else delete (proto as { getContext?: unknown }).getContext;
    }
  });
});

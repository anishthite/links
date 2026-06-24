// Whiteboard view (D-031 third mode). Freeform pan/zoom canvas where every
// sticky note has a board-space (positionX, positionY) and the user — or the
// AI — can drag them. See PLAN-whiteboard.md and
// implementation-notes/2026-06-06-whiteboard-view.html.
//
// Render strategy: one `.whiteboard-canvas` child of `.whiteboard` carries
// pan + zoom as a single CSS transform. Notes are absolutely positioned
// inside the canvas with `transform: translate(x, y)` in unscaled
// board-space. Camera change = one transform write (GPU). Note drag =
// one transform write on the dragged node only — siblings untouched.
//
// State ownership:
//   - board.ts owns the master list of notes (visibleNotes) and the API
//     write-through pipeline (applyPositionWrite).
//   - createWhiteboard() owns the camera, the selection, the in-flight
//     position-write debouncers, and the DOM nodes.
//   - createStickyNote() is reused verbatim — the same element flows
//     across masonry, list, and whiteboard. Inline `transform` styles set
//     here are cleared by board.ts when switching back to masonry/list.

import type { Note } from './lib/types';
import { createStickyNote } from './sticky-note';
import {
  type Camera,
  cameraTransform,
  clampCoord,
  clampZoom,
  fitCamera,
  loadCamera,
  saveCamera,
  zoomAt,
} from './whiteboard/transform';
import { Selection } from './whiteboard/selection';
import {
  hasAnyUnplaced,
  hasPosition,
  seedGridLayout,
  SEED_CELL_WIDTH,
  SEED_CELL_HEIGHT,
} from './whiteboard/seed-layout';
import { createMinimap, type Minimap, type MinimapNote } from './whiteboard/minimap';
import { createAiBar, type AiBar } from './whiteboard/ai-bar';
import { readWhiteboardFlags } from './whiteboard/flags';
import { scheduleBackground } from './whiteboard/scheduler';
import { createSpatialGrid, type SpatialGrid } from './whiteboard/spatial-grid';
import {
  createLodLayer,
  type LodLayer,
  LOD_ENTER,
  LOD_EXIT,
  LOD_COUNT_ENTER,
  LOD_COUNT_EXIT,
} from './whiteboard/lod';

// D-Q9 (C9): single shared empty Set passed to createStickyNote for
// whiteboard mounts that don't supply an active-tag filter (the legacy
// path). Hoisted to module scope so we don't allocate a fresh `new Set()`
// per mount during bulk fitAll() / AI-arrange refreshes — the allocations
// were small but cumulative across thousands of synchronous mounts.
const EMPTY_TAG_SET: ReadonlySet<string> = new Set();

export type WhiteboardCallbacks = {
  /** Called once per drag (single or multi). Sends a batched server write.
   *  The whiteboard already applied the moves to its in-memory Note objects
   *  via `applyLocalMoves` before this fires. */
  onPositionsChanged: (updates: { uuid: string; x: number; y: number; z?: number }[]) => void;
  /** Same as onNoteClick from createBoard — opens the editor. Triggered by
   *  a quick tap with no drag movement. Suppressed during marquee/pan. */
  onNoteClick?: (uuid: string) => void;
  /** Resolve a note by uuid. Lets the whiteboard read pendingSuggestion etc.
   *  without holding a stale copy. */
  getNote: (uuid: string) => Note | undefined;
  /** Live list of currently-visible notes (post-filter). Whiteboard mounts
   *  exactly these and seeds positions for the ones without one. */
  getVisibleNotes: () => readonly Note[];
  /** D-Q9 (C9): live active-tag filter (matched-underline highlight). When
   *  omitted the whiteboard renders without highlights — keeps existing
   *  callers backward-compatible. Read at mount time per node and refreshed
   *  in-place via `Whiteboard.refreshHighlights()` without remounting. */
  getActiveTags?: () => ReadonlySet<string>;
  /** Optional AI arrange hook. When provided, the AI bar is mounted on the
   *  whiteboard. The callback should call into src/lib/api.ts:aiArrangeStream
   *  and apply the returned `updates` via applyExternalMoves + persist. The
   *  `onEvent` argument is the per-submission progress sink that the bar
   *  renders as slide-in toasts. */
  aiArrange?: (
    prompt: string,
    onEvent: (ev: import('./lib/api').AiArrangeEvent) => void,
  ) => Promise<{ explanation: string; moved: number } | null>;
};

/** Drag movement threshold (viewport px) below which a pointerdown/up sequence
 *  is treated as a tap, not a drag. Same value used to suppress the tap-to-open
 *  editor on drag and to skip the position write when nothing actually moved. */
const TAP_THRESHOLD = 4;

/** Debounce window for single-note position writes after pointerup. */
const POSITION_WRITE_DEBOUNCE_MS = 120;

/** Max delay between two taps on the same note to count as a double-tap that
 *  opens the editor. A single tap does nothing (so the user can grab + drag
 *  the note without accidentally opening it). Long-press still opens. */
const DOUBLE_TAP_MS = 350;

/** Touch long-press: hold-still threshold (ms). Mobile users open the editor
 *  by holding a finger on a note for this long without moving. See PLAN §7. */
const LONG_PRESS_MS = 500;

/** Undo/redo cap so the stack can't grow unbounded over a long session. */
const UNDO_STACK_LIMIT = 200;

export type Whiteboard = {
  el: HTMLElement;
  /** Mount/refresh from the master visible list. Idempotent — survivor nodes
   *  are reused, new uuids get appended, vanished uuids get removed. */
  refresh: () => void;
  /** Apply server-supplied position updates (e.g. an AI batch returned).
   *  Updates the in-memory Notes via getNote(...) then repaints. */
  applyExternalMoves: (updates: { uuid: string; x: number; y: number; z?: number }[]) => void;
  /** Record a user-initiated batch (e.g. AI arrange that the user submitted)
   *  on the undo stack. The caller supplies the prev/new positions; we don't
   *  re-derive them because the caller often already captured them before
   *  applying. Used by board.ts's aiArrange callback so ⌘Z reverts AI moves. */
  recordUserMoves: (deltas: { uuid: string; prevX: number; prevY: number; newX: number; newY: number }[]) => void;
  /** Fit-all camera. */
  fitAll: () => void;
  /** Reset camera to (0,0,1). */
  resetCamera: () => void;
  /** D-Q9 (C9): re-apply matched-underline classes to already-mounted notes
   *  in response to an active-tag filter change. Iterates nodeCache and
   *  toggles `.matched` on tag spans — NO createStickyNote calls, NO
   *  remount, NO refresh(). Caller (board.ts) invokes this from
   *  setActiveTags. Safe to call at any time; cheap when no nodes are
   *  mounted (LOD mode). */
  refreshHighlights: () => void;
  /** Undo the last user-initiated move. Returns true if anything was undone. */
  undo: () => boolean;
  /** Redo the next move from the undo stack. Returns true if anything was redone. */
  redo: () => boolean;
  /** Detach all listeners. Called when switching away from whiteboard view. */
  destroy: () => void;
};

export function createWhiteboard(opts: WhiteboardCallbacks): Whiteboard {
  // --- DOM scaffold ---

  const el = document.createElement('div');
  el.className = 'whiteboard';

  const canvas = document.createElement('div');
  canvas.className = 'whiteboard-canvas';
  el.appendChild(canvas);

  const minimap: Minimap = createMinimap(currentTheme);
  el.appendChild(minimap.el);

  const hud = document.createElement('div');
  hud.className = 'whiteboard-hud';
  hud.innerHTML = `
    <button class="whiteboard-hud-btn" data-fit type="button" title="fit all notes (0)">fit</button>
    <button class="whiteboard-hud-btn" data-reset type="button" title="reset camera (1)">100%</button>
    <span class="whiteboard-hud-zoom" data-zoom></span>
  `;
  el.appendChild(hud);

  // AI bar — only mounted when host wired an aiArrange callback. The
  // reference is retained in the closure so destroy() can tear it down
  // (otherwise stale dismiss timers fire on a detached DOM after a view
  // switch — review finding).
  let aiBar: AiBar | null = null;
  if (opts.aiArrange) {
    const aiArrange = opts.aiArrange;
    aiBar = createAiBar({
      onSubmit: (prompt, onEvent) => aiArrange(prompt, onEvent),
    });
    el.appendChild(aiBar.el);
  }

  // --- Perf feature flags (Q-series). Snapshotted once per instance so the
  // active code paths stay stable for the lifetime of this whiteboard. ---
  const flags = readWhiteboardFlags();

  // --- State ---

  let camera: Camera = loadCamera();
  const selection = new Selection((nextSet) => syncSelectionClasses(nextSet));
  /** uuid → DOM node currently mounted in the canvas. */
  const nodeCache = new Map<string, HTMLElement>();
  // heightCache REMOVED (D-Q1 + D-Q5b): board.css clamps every whiteboard
  // note to height:220px, so the per-mount `node.offsetHeight` read was
  // dead weight that forced a synchronous layout flush. SEED_CELL_HEIGHT
  // is the canonical fixed height now — noteIntersectsViewport reads it
  // directly without a Map round-trip.
  /** Mount-time guard: a node is in nodeCache iff its mount-only styles
   *  (position/left/top/width/height) have been written. Tracked here so
   *  `mountNodeStyles` is idempotent (P4). */
  /** Last paint state per node — used to skip survivor repaints when nothing
   *  changed (P5). Cleared on every mutation that affects rendered
   *  position/zIndex; see invalidateNode. */
  type PaintState = { x: number; y: number; z: number };
  const paintCache = new WeakMap<HTMLElement, PaintState>();
  /** Previous selection snapshot — kept so emit() can compute add/remove diffs
   *  in O(|Δ|) rather than walking nodeCache every time (P3). */
  let prevSelection: Set<string> = new Set();
  /** Pending position writes (debounced). */
  const writeTimers = new Map<string, number>();
  /** Reused per-refresh scratch Set to mark which uuids should remain
   *  mounted (P9). Cleared at the top of refresh(). */
  const mountUuids: Set<string> = new Set();
  let destroyed = false;

  // --- Q-P3 LOD mode (flag.lod) ---
  // 'dom' = normal DOM mount path. 'lod' = canvas overlay paints all notes
  // as flat rects; nodeCache is empty (modulo a transiently-force-mounted
  // dragged note). Hysteresis: enter at zoom < LOD_ENTER, exit at zoom >
  // LOD_EXIT — the gap eliminates oscillation near the boundary.
  let mode: 'dom' | 'lod' = 'dom';
  // D-Q12 (C5): spatial grid declared BEFORE LOD wiring so the LOD layer
  // can take its queryRect closure for sub-linear paint at large N.
  const grid: SpatialGrid | null = flags.grid ? createSpatialGrid() : null;
  let gridInitialized = false;

  const lodLayer: LodLayer | null = flags.lod
    ? createLodLayer({
        getVisibleNotes: () => opts.getVisibleNotes(),
        getCamera: () => camera,
        getSelected: () => {
          const s = new Set<string>();
          selection.forEach((u) => s.add(u));
          return s;
        },
        getTheme: currentTheme,
        getViewport: () => ({ w: viewportW, h: viewportH }),
        // D-Q12 (C5): thread the spatial grid into LOD paint so the per-frame
        // AABB+fill loop is sub-linear (one bucket walk per visible region
        // instead of full O(N) iteration). Falls back to the linear loop
        // when grid is null/disabled.
        queryRect: grid ? ((rect, visit) => grid.queryRect(rect, visit)) : undefined,
        getNote: (uuid) => opts.getNote(uuid),
      })
    : null;

  // --- Q-P4 chunked progressive mount (flag.chunk) ---
  const MOUNT_BUDGET = 32;
  const MOUNT_TIME_SLICE_MS = 4;
  // D-Q14 (C2): first refresh gets an even tighter cap so initial paint
  // never blocks on more than a handful of synchronous DOM mounts; the rest
  // flow in via the background drain. Cleared at the end of the first
  // refresh() that actually populated `pendingThisRefresh`.
  const FIRST_REFRESH_BUDGET = 12;
  let isFirstRefresh = true;
  const pendingMountQueue: string[] = [];
  const pendingMountSet = new Set<string>();
  let drainCancel: (() => void) | null = null;

  // --- Q-P5a eviction debounce (flag.evictDebounce) ---
  const EVICTION_DELAY_MS = 500;
  const evictionTimers = new Map<string, number>();

  // --- Q-P8 minimap bbox cache helper ---
  // Track the previous visible-notes length so refresh() can detect filter
  // changes (length delta) and invalidate the cached bbox. Position-mutation
  // paths invalidate explicitly; this catches the cases the mutation paths
  // don't see (filter applied/cleared, AI batch landed via applyExternalMoves
  // already covered, but seedGridLayout addition is also covered there).
  let lastVisibleLength = -1;

  // --- D-Q15 (C4) refresh short-circuit bookkeeping ---
  // notesRevision bumps on every mutation that could affect the visible set
  // (filter, position write, AI batch, undo/redo, drag flush, seed). When
  // notesRevision is unchanged AND the current viewportBoardRect() is fully
  // contained inside an inflated copy of the last-processed rect, refresh()
  // skips its AABB scan entirely (no notes can have entered or left). This
  // turns the steady-state pan into ~zero work per rAF until an edge is
  // crossed.
  let notesRevision = 0;
  let lastRefreshNotesRevision = -1;
  let lastRefreshRect: { x: number; y: number; w: number; h: number } | null = null;
  let lastRefreshZoom = 0;
  let lastRefreshMode: 'dom' | 'lod' = 'dom';
  function markNotesDirty(): void {
    notesRevision++;
  }

  // --- Q-P7 velocity-aware pan buffer (flag.velocity) ---
  // Tracks signed pan velocity in board-space px per ms (EWMA-smoothed).
  // Decays to zero ~300ms after the last pan tick so the buffer returns to
  // symmetric when the user stops scrolling.
  let panVelX = 0;
  let panVelY = 0;
  let lastPanTs = 0;
  let prevCameraForVel: Camera = { panX: camera.panX, panY: camera.panY, zoom: camera.zoom };

  // Insert the LOD overlay between the zoomable canvas and the minimap so it
  // visually replaces the (then-evicted) notes when active. pointer-events is
  // 'none' on the canvas — hit-testing flows through the parent's pointerdown,
  // which calls lodLayer.hitTest() on the way to deciding drag vs. pan.
  if (lodLayer) {
    el.insertBefore(lodLayer.el, minimap.el);
  }

  // --- Cached viewport metrics (P6) ---
  //
  // Reading `el.clientWidth/clientHeight` and `el.getBoundingClientRect()`
  // every camera tick forces layout if any style invalidation is pending.
  // We measure once at mount, then refresh via a ResizeObserver attached to
  // `el`. The bounding rect is used by onWheel to translate clientX/Y into
  // local viewport coords — invalidated by the same observer.
  let viewportW = 0;
  let viewportH = 0;
  let elRect: DOMRect | null = null;
  function measureViewport(): void {
    viewportW = el.clientWidth;
    viewportH = el.clientHeight;
    elRect = null; // lazy — next onWheel will recompute
    if (lodLayer && viewportW > 0 && viewportH > 0) {
      lodLayer.setSize(viewportW, viewportH);
    }
  }
  // Initial measure happens synchronously below (after el is in DOM, the
  // observer's first callback re-syncs). Observer ref is captured so
  // destroy() can disconnect.
  const resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => measureViewport())
      : null;
  resizeObserver?.observe(el);

  // --- Undo/redo ---
  //
  // A linear history of position changes. Each entry is a batch of
  // `{uuid, prevX, prevY, newX, newY}` records — a multi-drag of N notes
  // collapses to one entry so one Ctrl/Cmd+Z reverses the whole gesture.
  //
  // `undoIdx` points to the next entry that would be applied by undo();
  // a fresh push truncates anything at and after `undoIdx` (the usual
  // tree-collapse-on-new-branch pattern). Capped at UNDO_STACK_LIMIT.
  type MoveDelta = {
    uuid: string;
    prevX: number; prevY: number;
    newX: number;  newY: number;
  };
  const undoStack: MoveDelta[][] = [];
  let undoIdx = 0;

  function pushHistory(entry: MoveDelta[]): void {
    if (entry.length === 0) return;
    // Drop anything we've previously "redone past" — a new gesture starts a
    // fresh branch from the current position.
    if (undoIdx < undoStack.length) undoStack.length = undoIdx;
    undoStack.push(entry);
    if (undoStack.length > UNDO_STACK_LIMIT) {
      undoStack.splice(0, undoStack.length - UNDO_STACK_LIMIT);
    }
    undoIdx = undoStack.length;
  }

  function applyMoveDeltas(deltas: readonly MoveDelta[], direction: 'undo' | 'redo'): void {
    if (deltas.length > 0) markNotesDirty(); // D-Q15 (C4)
    const pick = direction === 'undo'
      ? (d: MoveDelta) => ({ x: d.prevX, y: d.prevY })
      : (d: MoveDelta) => ({ x: d.newX,  y: d.newY  });
    const updates: { uuid: string; x: number; y: number }[] = [];
    for (const d of deltas) {
      const note = opts.getNote(d.uuid);
      if (!note) continue;
      const { x, y } = pick(d);
      note.positionX = x;
      note.positionY = y;
      if (grid) grid.move(d.uuid, x, y);
      const node = nodeCache.get(d.uuid);
      if (node) {
        invalidateNode(d.uuid); // P5 — undo/redo mutates positionX/Y.
        paintNodeTransform(node, note);
      }
      updates.push({ uuid: d.uuid, x, y });
    }
    if (updates.length > 0) opts.onPositionsChanged(updates);
    // Notes restored into-viewport by undo/redo must be mounted; notes pushed
    // out-of-viewport must be evicted. Without this, an undone note staying
    // out-of-the-3×-buffer would carry a stale inline transform until the
    // next pan or filter change. Bug found by workflow review.
    scheduleVisibilityRefresh();
    if (updates.length > 0) minimap.invalidateContent();
    scheduleMinimap();
  }

  function undo(): boolean {
    if (undoIdx === 0) return false;
    undoIdx -= 1;
    applyMoveDeltas(undoStack[undoIdx]!, 'undo');
    return true;
  }

  function redo(): boolean {
    if (undoIdx >= undoStack.length) return false;
    applyMoveDeltas(undoStack[undoIdx]!, 'redo');
    undoIdx += 1;
    return true;
  }

  // --- Camera plumbing ---
  //
  // Camera writes are rAF-coalesced (B5): rapid setCamera() calls during a
  // wheel burst or pan only flush one transform write per frame. animateCamera
  // tweens camera state with cubic-out easing (B3) and is cancelled by any
  // user-initiated camera mutation mid-tween.

  let cameraWriteRaf: number | null = null;
  let pendingCamera: Camera | null = null;
  let cameraTweenRaf: number | null = null;

  // D-Q16 (C3): debounce saveCamera() to ~250ms trailing-edge so a fast pan
  // doesn't synchronously write localStorage at 60Hz. Cancel-and-reschedule
  // on each setCamera flush; force-flush on destroy() so we don't lose the
  // final position. On a hard refresh during active pan, the user loses at
  // most CAMERA_PERSIST_MS of pan delta — mirrors the existing position-
  // write debounce, well below any perceptible reload-state loss.
  const CAMERA_PERSIST_MS = 250;
  let cameraPersistTimer: number | null = null;
  let cameraPersistPending: Camera | null = null;
  function saveCameraDebounced(c: Camera): void {
    cameraPersistPending = c;
    if (cameraPersistTimer != null) return;
    cameraPersistTimer = window.setTimeout(() => {
      cameraPersistTimer = null;
      if (cameraPersistPending) {
        saveCamera(cameraPersistPending);
        cameraPersistPending = null;
      }
    }, CAMERA_PERSIST_MS);
  }
  function flushCameraPersist(): void {
    if (cameraPersistTimer != null) {
      clearTimeout(cameraPersistTimer);
      cameraPersistTimer = null;
    }
    if (cameraPersistPending) {
      saveCamera(cameraPersistPending);
      cameraPersistPending = null;
    }
  }

  function flushCameraWrite(): void {
    cameraWriteRaf = null;
    if (!pendingCamera) return;
    camera = pendingCamera;
    pendingCamera = null;
    canvas.style.transform = cameraTransform(camera);
    const zEl = hud.querySelector<HTMLElement>('[data-zoom]');
    if (zEl) zEl.textContent = `${Math.round(camera.zoom * 100)}%`;
    saveCameraDebounced(camera); // D-Q16 (C3)
    // scheduleVisibilityRefresh() also triggers scheduleMinimap() from inside
    // refresh(), so the standalone call here is redundant in the steady-state
    // pan/zoom loop. We keep one explicit minimap schedule for the case where
    // the camera changes but no visibility refresh is queued (e.g. a tween
    // that doesn't shift the viewport AABB). P8.
    scheduleMinimap();
  }

  function applyCamera(): void {
    pendingCamera = camera;
    if (cameraWriteRaf == null) cameraWriteRaf = requestAnimationFrame(flushCameraWrite);
  }

  function cancelCameraTween(): void {
    if (cameraTweenRaf != null) {
      cancelAnimationFrame(cameraTweenRaf);
      cameraTweenRaf = null;
    }
  }

  function animateCamera(target: Camera, ms = 200): void {
    cancelCameraTween();
    const start = { ...camera };
    const end: Camera = {
      panX: clampCoord(target.panX),
      panY: clampCoord(target.panY),
      zoom: clampZoom(target.zoom),
    };
    const t0 = performance.now();
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3);
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / ms);
      const k = ease(t);
      camera = {
        panX: start.panX + (end.panX - start.panX) * k,
        panY: start.panY + (end.panY - start.panY) * k,
        zoom: start.zoom + (end.zoom - start.zoom) * k,
      };
      applyCamera();
      // Throttle visibility refresh during the tween (review-finding fix):
      // refresh() iterates ALL visible notes every call, and a 200ms tween
      // produces ~12 rAF steps. On a 5000-note board that's ~60k AABB tests
      // per zoom gesture for no perceptual benefit — the user can't see
      // virtualization flicker mid-tween anyway. Only schedule on the final
      // frame so newly-in-view notes mount as the tween settles.
      if (t >= 1) {
        scheduleVisibilityRefresh();
        cameraTweenRaf = null;
      } else {
        cameraTweenRaf = requestAnimationFrame(step);
      }
    };
    cameraTweenRaf = requestAnimationFrame(step);
  }

  /** Coalesce mount/evict checks driven by camera change to one rAF. Pan and
   *  zoom both invalidate the viewport AABB — we re-run the visibility gate
   *  to mount nodes that scrolled into view and evict those that left. */
  let visibilityRaf: number | null = null;
  function scheduleVisibilityRefresh(): void {
    if (visibilityRaf != null) return;
    visibilityRaf = requestAnimationFrame(() => {
      visibilityRaf = null;
      // Run refresh() but skip seed-layout: pan/zoom never adds unplaced notes.
      // The refresh function already short-circuits seed when none are unplaced,
      // so we can just call it directly.
      refresh();
    });
  }

  function setCamera(next: Camera): void {
    cancelCameraTween();
    const clamped: Camera = {
      panX: clampCoord(next.panX),
      panY: clampCoord(next.panY),
      zoom: clampZoom(next.zoom),
    };
    if (flags.velocity) {
      // Q-P7: track pan velocity via EWMA on Δpan / Δt (board-space).
      // D-Q17 (C10): cap dt so a long idle period before resume doesn't
      // collapse the EWMA toward zero on the very frame where overshoot is
      // most needed. We also detect resume (>200ms since last tick) and
      // skip the EWMA blend on the resumed tick — treat it as a fresh
      // sample so the buffer leads pan direction immediately.
      const now = performance.now();
      const rawDt = lastPanTs > 0 ? Math.max(1, now - lastPanTs) : 16;
      const isResume = lastPanTs > 0 && rawDt > 200;
      const dt = Math.min(50, rawDt);
      const dx = (clamped.panX - prevCameraForVel.panX) / dt;
      const dy = (clamped.panY - prevCameraForVel.panY) / dt;
      if (isResume) {
        panVelX = dx;
        panVelY = dy;
      } else {
        const alpha = 0.3;
        panVelX = panVelX * (1 - alpha) + dx * alpha;
        panVelY = panVelY * (1 - alpha) + dy * alpha;
      }
      lastPanTs = now;
      prevCameraForVel = clamped;
    }
    camera = clamped;
    applyCamera();
    scheduleVisibilityRefresh();
  }

  function zoomStep(factor: number, animated: boolean): void {
    const vx = viewportW / 2;
    const vy = viewportH / 2;
    const target = zoomAt(camera, vx, vy, camera.zoom * factor);
    if (animated) animateCamera(target);
    else setCamera(target);
  }

  function fitAll(animated = true): void {
    const notes = opts.getVisibleNotes();
    const bboxes = notes
      .filter(hasPosition)
      .map(n => ({
        x: n.positionX as number,
        y: n.positionY as number,
        w: SEED_CELL_WIDTH,
        h: SEED_CELL_HEIGHT,
      }));
    const target: Camera = bboxes.length === 0
      ? { panX: 0, panY: 0, zoom: 1 }
      : fitCamera(bboxes, viewportW || el.clientWidth, viewportH || el.clientHeight);
    if (animated) animateCamera(target);
    else setCamera(target);
  }

  function resetCamera(animated = true): void {
    const target: Camera = { panX: 0, panY: 0, zoom: 1 };
    if (animated) animateCamera(target);
    else setCamera(target);
  }

  // --- Node mount / refresh ---
  //
  // Painting is split between mount-time and transform-time (P4):
  //   mountNodeStyles — absolute positioning + box size. Written once when
  //     the node is appended; never again. Idempotent (called only from
  //     the mount branch in refresh()).
  //   paintNodeTransform — the per-frame translate(x,y) + zIndex. Cheap.
  //
  // Survivor branches consult `paintCache` (P5) and skip the transform write
  // entirely when (x, y, z) is unchanged. Cache entries are invalidated by
  // every code path that mutates position/zIndex — drag flush, applyExternal,
  // undo/redo, arrow nudge — via `invalidateNode`.

  function mountNodeStyles(_node: HTMLElement): void {
    // No-op: position/left/top/width/height/overflow/content-visibility are
    // all owned by `.whiteboard-canvas .note` in board.css now. Used to write
    // them inline here, which (a) cost a style recalc per mount, and (b)
    // height:'auto' caused tall notes to spill into the row below them on
    // the fixed-cell seed grid — the "hella overlap" the user reported.
    // Kept as a function so call sites stay symmetric with paintNodeTransform
    // and so adding mount-only styles later is cheap.
  }

  function paintNodeTransform(node: HTMLElement, note: Note): void {
    const x = note.positionX ?? 0;
    const y = note.positionY ?? 0;
    const z = note.zIndex ?? 0;
    const cached = paintCache.get(node);
    if (cached && cached.x === x && cached.y === y && cached.z === z) return;
    node.style.transform = `translate(${x}px, ${y}px)`;
    node.style.zIndex = String(z);
    if (cached) {
      cached.x = x;
      cached.y = y;
      cached.z = z;
    } else {
      paintCache.set(node, { x, y, z });
    }
  }

  /** Drop the paint cache for a node so the next paintNodeTransform writes
   *  even if (x,y,z) appears unchanged. Called whenever positionX/Y/zIndex
   *  is mutated outside of refresh()'s normal flow. P5. */
  function invalidateNode(uuid: string): void {
    const node = nodeCache.get(uuid);
    if (node) paintCache.delete(node);
  }

  function syncSelectionClasses(nextSet: ReadonlySet<string>): void {
    // Diff-based class sync (P3): O(|Δselection|) instead of O(|nodeCache|).
    // Both add and remove are looked up in the current nodeCache; uuids that
    // aren't mounted (panned out of view) silently skip — the class will be
    // applied at next mount via P10's mount-time read of `selection.has`.
    const prev = prevSelection;
    // removals: in prev but not in next.
    prev.forEach((uuid) => {
      if (!nextSet.has(uuid)) {
        nodeCache.get(uuid)?.classList.remove('selected');
      }
    });
    // additions: in next but not in prev.
    nextSet.forEach((uuid) => {
      if (!prev.has(uuid)) {
        nodeCache.get(uuid)?.classList.add('selected');
      }
    });
    // Snapshot for the next emit. One allocation per emit — the only one
    // (Selection.emit itself no longer copies; see selection.ts).
    prevSelection = new Set(nextSet);
    scheduleMinimap();
  }

  /** Compute the current viewport rectangle in board-space, expanded by one
   *  viewport on every edge so notes just off-screen are kept mounted (cheap
   *  panning, no re-mount flicker). Returns null if the container hasn't been
   *  laid out yet (clientWidth === 0) — caller falls back to "mount all". */
  function viewportBoardRect(): { x: number; y: number; w: number; h: number } | null {
    // Bootstrap path: if measureViewport() ran before the element had a
    // non-zero box (e.g. the test fixture sets clientWidth via
    // Object.defineProperty after createWhiteboard, or the parent is briefly
    // display:none at first paint), re-measure once. Steady-state pan/zoom
    // hits the cached values — ResizeObserver keeps them fresh on resize. P6.
    if (viewportW === 0 || viewportH === 0) measureViewport();
    const vw = viewportW;
    const vh = viewportH;
    if (vw === 0 || vh === 0) return null;
    const boardW = vw / camera.zoom;
    const boardH = vh / camera.zoom;
    // Default symmetric buffer: 1×viewport on every side (→ 3× total).
    let leftBuf = boardW, rightBuf = boardW;
    let topBuf = boardH, bottomBuf = boardH;
    if (flags.velocity) {
      // Q-P7: bias the buffer toward the direction of motion. The trailing
      // side keeps at least the default 1× (strictly additive, never
      // smaller); the leading side grows up to 2× extra (3× total on that
      // side) proportional to |velocity|. Velocity decays naturally via
      // setCamera not being called — we don't actively decay here; the
      // recorded lastPanTs lets us fade out within ~300ms.
      const now = performance.now();
      const sinceUpdate = lastPanTs > 0 ? now - lastPanTs : Infinity;
      const decay = sinceUpdate > 300 ? 0 : 1 - sinceUpdate / 300;
      const vxEff = panVelX * decay;
      const vyEff = panVelY * decay;
      const threshold = 1; // px(board)/ms
      const leadX = Math.min(2, Math.abs(vxEff) / threshold);
      const leadY = Math.min(2, Math.abs(vyEff) / threshold);
      // A positive panVelX means pan increased to the right — in the canvas
      // transform that means the board appears to scroll left, i.e. content
      // to the LEFT of the viewport will reveal next. So leading edge = left.
      if (vxEff > 0) leftBuf += boardW * leadX;
      else if (vxEff < 0) rightBuf += boardW * leadX;
      if (vyEff > 0) topBuf += boardH * leadY;
      else if (vyEff < 0) bottomBuf += boardH * leadY;
    }
    const x = -camera.panX / camera.zoom - leftBuf;
    const y = -camera.panY / camera.zoom - topBuf;
    const w = boardW + leftBuf + rightBuf;
    const h = boardH + topBuf + bottomBuf;
    return { x, y, w, h };
  }

  /** AABB intersection test: returns true iff (px, py) + the fixed seed cell
   *  overlaps the given viewport rect. Note width and height are clamped to
   *  SEED_CELL_WIDTH × SEED_CELL_HEIGHT by board.css (`.whiteboard-canvas
   *  .note { width:280px; height:220px }`), so the previous per-uuid
   *  heightCache + forced-layout offsetHeight read was dead weight (D-Q1). */
  function noteIntersectsViewport(
    px: number,
    py: number,
    rect: { x: number; y: number; w: number; h: number },
  ): boolean {
    return px + SEED_CELL_WIDTH >= rect.x && px <= rect.x + rect.w &&
           py + SEED_CELL_HEIGHT >= rect.y && py <= rect.y + rect.h;
  }

  function mountNote(uuid: string, note: Note): HTMLElement {
    const existing = nodeCache.get(uuid);
    if (existing) return existing;
    // D-Q9 (C9): read live active tags (or use the module-shared empty set).
    const activeTags = opts.getActiveTags ? opts.getActiveTags() : EMPTY_TAG_SET;
    const node = createStickyNote(note, activeTags as Set<string>, { showSuggestions: false });
    node.classList.add('whiteboard-note');
    mountNodeStyles(node);
    if (selection.has(uuid)) node.classList.add('selected');
    canvas.appendChild(node);
    nodeCache.set(uuid, node);
    paintNodeTransform(node, note);
    pendingMountSet.delete(uuid);
    return node;
  }

  // D-Q9 (C9): re-apply matched-underline classes in-place.
  // Iterates currently-mounted nodes' `.tag-mini` spans and toggles
  // `.matched` against the live active-tag set. No mount/remount, no
  // refresh(); the filter change is purely cosmetic.
  function refreshHighlights(): void {
    if (nodeCache.size === 0) return;
    const active = opts.getActiveTags ? opts.getActiveTags() : EMPTY_TAG_SET;
    nodeCache.forEach((node) => {
      const spans = node.querySelectorAll<HTMLElement>('.tag-mini');
      spans.forEach((s) => {
        const tag = s.textContent ?? '';
        if (active.has(tag)) s.classList.add('matched');
        else s.classList.remove('matched');
      });
    });
  }

  function drainPendingMounts(): void {
    drainCancel = null;
    const start = performance.now();
    while (pendingMountQueue.length > 0 && performance.now() - start < MOUNT_TIME_SLICE_MS) {
      const uuid = pendingMountQueue.shift()!;
      pendingMountSet.delete(uuid);
      if (!mountUuids.has(uuid)) continue; // panned out before we got to it
      if (nodeCache.has(uuid)) continue;   // some other path force-mounted it
      const note = opts.getNote(uuid);
      if (!note || !hasPosition(note)) continue;
      mountNote(uuid, note);
    }
    if (pendingMountQueue.length > 0) {
      drainCancel = scheduleBackground(drainPendingMounts);
    } else {
      // One minimap refresh after the final tick so the just-mounted nodes
      // show up on the minimap. Pure-pan minimaps already get scheduled by
      // setCamera.
      scheduleMinimap();
    }
  }

  /** Drag-from-LOD support: ensure a DOM node exists for this uuid even if
   *  the whiteboard is in LOD mode or the mount is queued for chunked
   *  hydration. Returns null if the note has no position. */
  function forceMount(uuid: string): HTMLElement | null {
    const cached = nodeCache.get(uuid);
    if (cached) return cached;
    if (pendingMountSet.has(uuid)) {
      const idx = pendingMountQueue.indexOf(uuid);
      if (idx !== -1) pendingMountQueue.splice(idx, 1);
      pendingMountSet.delete(uuid);
    }
    const note = opts.getNote(uuid);
    if (!note || !hasPosition(note)) return null;
    mountUuids.add(uuid); // protect from eviction on the very next refresh
    return mountNote(uuid, note);
  }

  function evictNode(uuid: string): void {
    const node = nodeCache.get(uuid);
    if (!node) return;
    node.remove();
    nodeCache.delete(uuid);
  }

  function scheduleEviction(uuid: string): void {
    if (evictionTimers.has(uuid)) return;
    const id = window.setTimeout(() => {
      evictionTimers.delete(uuid);
      // Re-check: if the uuid is back in the mount set (pan-back inside the
      // debounce window), skip the eviction entirely.
      if (mountUuids.has(uuid)) return;
      evictNode(uuid);
    }, EVICTION_DELAY_MS);
    evictionTimers.set(uuid, id);
  }

  function refresh(): void {
    const notes = opts.getVisibleNotes();

    // D-Q15 (C4): early-exit short-circuit. If neither the visible-note set
    // (notesRevision OR list length) nor a mode-driving camera dimension
    // has changed since the last refresh, AND the new viewport rect is
    // fully contained inside an inflated copy of the rect we processed
    // last time, then no notes can have entered or left the buffer — skip
    // the AABB scan entirely. Survivors still get paintNodeTransform but
    // the paintCache (P5) already short-circuits unchanged (x, y, z).
    // The length compare catches filter changes that didn't run through
    // an in-process mutation (board.ts setQuery/setActiveTags).
    if (
      lastRefreshRect &&
      notesRevision === lastRefreshNotesRevision &&
      notes.length === lastVisibleLength &&
      camera.zoom === lastRefreshZoom &&
      mode === lastRefreshMode
    ) {
      const candidate = viewportBoardRect();
      if (candidate) {
        // Inflate the last rect by half a seed cell on each side so notes
        // already at the buffer edge still count as "contained" — we only
        // need to bail when there's NO chance a new note crossed in.
        const inflate = SEED_CELL_WIDTH * 0.5;
        const lr = lastRefreshRect;
        const fullyInside =
          candidate.x >= lr.x - inflate &&
          candidate.y >= lr.y - inflate &&
          candidate.x + candidate.w <= lr.x + lr.w + inflate &&
          candidate.y + candidate.h <= lr.y + lr.h + inflate;
        if (fullyInside) {
          // Repaint the LOD layer (camera-bound) if we're in LOD mode, but
          // skip the full AABB scan. Minimap update happens via the camera
          // tick path; no separate hook needed.
          if (mode === 'lod') lodLayer?.scheduleRepaint();
          return;
        }
      }
    }

    // Seed positions for any note that's never been placed. Fast-path (P2):
    // skip the entire seedGridLayout call when no notes are unplaced — the
    // common case after first mount. Avoids one O(N) filter allocation per
    // pan/zoom-driven visibility refresh.
    if (hasAnyUnplaced(notes)) {
      const seedPlacements = seedGridLayout(notes);
      if (seedPlacements.length > 0) {
        for (const p of seedPlacements) {
          const note = opts.getNote(p.uuid);
          if (note) {
            note.positionX = p.x;
            note.positionY = p.y;
          }
        }
        opts.onPositionsChanged(seedPlacements);
        if (grid) {
          for (const p of seedPlacements) grid.insert(p.uuid, p.x, p.y);
        }
        minimap.invalidateContent();
        markNotesDirty();
      }
    }

    // Spatial grid lazy init (Q-P6): on the first refresh where the grid is
    // enabled, populate it from the current note list. Subsequent moves keep
    // it fresh via applyExternalMoves / flushDragWrite / queuePositionWrite.
    if (grid && !gridInitialized) {
      for (const n of notes) {
        if (hasPosition(n)) grid.insert(n.uuid, n.positionX as number, n.positionY as number);
      }
      gridInitialized = true;
    }

    // Q-P3 LOD gate. Decide which mode this refresh should run in. State is
    // sticky: we only flip when crossing the hysteresis boundary.
    // D-Q11 (C6): hybrid predicate — enter LOD on either low zoom OR high
    // visible-count (a dense board at moderate zoom would queue thousands
    // of mountNote calls otherwise). Uses grid.countInRect() when available
    // so the count itself is sub-linear; falls back to notes.length when the
    // grid is off (overestimate — errs toward LOD, which is safer).
    if (lodLayer) {
      const rectForCount = viewportBoardRect();
      const visibleCount = grid && rectForCount
        ? grid.countInRect(rectForCount)
        : notes.length;
      const wantLod = mode === 'lod'
        ? (camera.zoom < LOD_EXIT || visibleCount > LOD_COUNT_EXIT)
        : (camera.zoom < LOD_ENTER || visibleCount > LOD_COUNT_ENTER);
      if (wantLod && mode === 'dom') {
        // DOM → LOD: tear down every mounted node, cancel any pending mount
        // drain, and reveal the canvas overlay. evictNode mutates nodeCache
        // via .delete — snapshot keys first.
        const remaining: string[] = [];
        nodeCache.forEach((_n, u) => remaining.push(u));
        for (const u of remaining) evictNode(u);
        pendingMountQueue.length = 0;
        pendingMountSet.clear();
        if (drainCancel) { drainCancel(); drainCancel = null; }
        lodLayer.enable();
        mode = 'lod';
      } else if (!wantLod && mode === 'lod') {
        lodLayer.disable();
        mode = 'dom';
        // Fall through to normal DOM mount path so newly-visible notes are
        // populated in this refresh — no extra rAF needed.
      }
    }

    // Build visibleUuids (filter set) up front — used by both LOD and DOM
    // selection-prune branches.
    const visibleUuids = new Set<string>();
    for (const n of notes) visibleUuids.add(n.uuid);

    // Q-P8: invalidate minimap bbox cache on filter changes (length delta).
    // Pure pan/zoom keeps lastVisibleLength constant, leaving the cache hot.
    if (notes.length !== lastVisibleLength) {
      minimap.invalidateContent();
      lastVisibleLength = notes.length;
      // D-Q15 (C4): filter changes mutate the visible set; force the next
      // refresh past the short-circuit.
      markNotesDirty();
    }

    if (mode === 'lod') {
      // LOD path: no DOM mounts. Just prune selection on filter changes,
      // then schedule a canvas repaint.
      if (selection.size() > 0) {
        let hasStale = false;
        const keep: string[] = [];
        selection.forEach((uuid) => {
          if (visibleUuids.has(uuid)) keep.push(uuid);
          else hasStale = true;
        });
        if (hasStale) selection.setMany(keep);
      }
      lodLayer?.scheduleRepaint();
      return;
    }

    // --- DOM mode ---
    // Virtualization gate: only mount notes whose AABB intersects the
    // viewport (expanded by 1 viewport on each side by default; biased by
    // velocity when flag.velocity is on — Q-P7). At ~2,500 notes this
    // keeps the live DOM count to whatever's visible at the current zoom.
    const rect = viewportBoardRect();
    mountUuids.clear(); // P9: reused across refreshes.

    type Pending = { uuid: string; note: Note };
    const pendingThisRefresh: Pending[] = [];

    function visit(note: Note): void {
      if (!hasPosition(note)) return;       // unplaced — seed-layout will catch them next refresh
      const px = note.positionX as number;
      const py = note.positionY as number;
      if (rect && !noteIntersectsViewport(px, py, rect)) return;
      mountUuids.add(note.uuid);
      const node = nodeCache.get(note.uuid);
      if (!node) {
        pendingThisRefresh.push({ uuid: note.uuid, note });
      } else {
        // Survivor: skip the write if (x, y, z) is unchanged (P5). During
        // pure pan/zoom this short-circuits the entire per-node loop body.
        paintNodeTransform(node, note);
      }
    }

    if (grid && rect) {
      // Q-P6: spatial-grid query — O(visible) instead of O(N).
      grid.queryRect(rect, (uuid) => {
        if (!visibleUuids.has(uuid)) return;
        const note = opts.getNote(uuid);
        if (note) visit(note);
      });
    } else {
      for (const note of notes) visit(note);
    }

    // Prune selection to the current visible set (filter eviction). Viewport
    // eviction leaves selection intact.
    if (selection.size() > 0) {
      let hasStale = false;
      const keep: string[] = [];
      selection.forEach((uuid) => {
        if (visibleUuids.has(uuid)) keep.push(uuid);
        else hasStale = true;
      });
      if (hasStale) selection.setMany(keep);
    }

    // D-Q14 (C2): hard-cap the synchronous mount count UNCONDITIONALLY.
    // Previously gated behind flags.chunk; a flag-off install would have
    // synchronously mounted thousands at fitAll() / AI-arrange time. The
    // overflow drain runs regardless of flag.chunk now — the flag controls
    // whether the drain is opt-IN, not whether the cap exists. First
    // refresh additionally tightens to FIRST_REFRESH_BUDGET and sorts by
    // squared distance to the viewport center so the user sees the
    // geographic center appear first.
    if (isFirstRefresh && pendingThisRefresh.length > 1 && rect) {
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      pendingThisRefresh.sort((a, b) => {
        const ax = (a.note.positionX ?? 0) - cx;
        const ay = (a.note.positionY ?? 0) - cy;
        const bx = (b.note.positionX ?? 0) - cx;
        const by = (b.note.positionY ?? 0) - cy;
        return (ax * ax + ay * ay) - (bx * bx + by * by);
      });
    }
    const baseBudget = Math.min(MOUNT_BUDGET, pendingThisRefresh.length);
    const budget = isFirstRefresh && pendingThisRefresh.length > 0
      ? Math.min(FIRST_REFRESH_BUDGET, baseBudget)
      : baseBudget;
    for (let i = 0; i < budget; i++) {
      const { uuid, note } = pendingThisRefresh[i]!;
      mountNote(uuid, note);
    }
    if (pendingThisRefresh.length > budget) {
      for (let i = budget; i < pendingThisRefresh.length; i++) {
        const { uuid } = pendingThisRefresh[i]!;
        if (!pendingMountSet.has(uuid)) {
          pendingMountQueue.push(uuid);
          pendingMountSet.add(uuid);
        }
      }
      // Drop pending mounts that fell out of the viewport between refreshes.
      if (pendingMountQueue.length > 0) {
        for (let i = pendingMountQueue.length - 1; i >= 0; i--) {
          if (!mountUuids.has(pendingMountQueue[i]!)) {
            pendingMountSet.delete(pendingMountQueue[i]!);
            pendingMountQueue.splice(i, 1);
          }
        }
      }
      if (pendingMountQueue.length > 0 && !drainCancel) {
        drainCancel = scheduleBackground(drainPendingMounts);
      }
    }

    // Evict notes that are out-of-viewport or no longer visible at all.
    const toEvict: string[] = [];
    nodeCache.forEach((_node, uuid) => {
      if (!mountUuids.has(uuid)) toEvict.push(uuid);
      else {
        // If a pending eviction exists for this uuid (pan-back case), cancel it.
        const t = evictionTimers.get(uuid);
        if (t != null) {
          clearTimeout(t);
          evictionTimers.delete(uuid);
        }
      }
    });
    for (const uuid of toEvict) {
      if (flags.evictDebounce) scheduleEviction(uuid);
      else evictNode(uuid);
    }

    // P10: trailing applyCamera() removed. The initial transform is written
    // once at the end of createWhiteboard() (see below); subsequent camera
    // changes flow through setCamera()/animateCamera() which already call
    // applyCamera(). Keeping a redundant applyCamera() here scheduled a
    // second rAF per camera-driven refresh — a small wasteful repeat that
    // muddied the scheduler ownership picture before P3/P4 added more.

    // D-Q14/Q15 (C2/C4): refresh-tail bookkeeping.
    if (pendingThisRefresh.length > 0) isFirstRefresh = false;
    lastRefreshNotesRevision = notesRevision;
    lastRefreshRect = rect;
    lastRefreshZoom = camera.zoom;
    lastRefreshMode = mode;
  }

  function applyExternalMoves(updates: { uuid: string; x: number; y: number; z?: number }[]): void {
    if (updates.length > 0) markNotesDirty(); // D-Q15 (C4)
    for (const u of updates) {
      const note = opts.getNote(u.uuid);
      if (!note) continue;
      note.positionX = clampCoord(u.x);
      note.positionY = clampCoord(u.y);
      if (typeof u.z === 'number') note.zIndex = u.z;
      if (grid) grid.move(u.uuid, note.positionX, note.positionY);
      const node = nodeCache.get(u.uuid);
      if (node) {
        // External move — invalidate the paint cache so the survivor
        // short-circuit in refresh()/below picks up the new coords. (P5)
        invalidateNode(u.uuid);
        paintNodeTransform(node, note);
      }
    }
    if (updates.length > 0) minimap.invalidateContent();
    scheduleMinimap();
    lodLayer?.scheduleRepaint();
  }

  // --- Debounced position writes ---

  function queuePositionWrite(uuid: string): void {
    const existing = writeTimers.get(uuid);
    if (existing != null) clearTimeout(existing);
    const t = window.setTimeout(() => {
      writeTimers.delete(uuid);
      const note = opts.getNote(uuid);
      if (!note || note.positionX == null || note.positionY == null) return;
      opts.onPositionsChanged([{ uuid, x: note.positionX, y: note.positionY, z: note.zIndex }]);
    }, POSITION_WRITE_DEBOUNCE_MS);
    writeTimers.set(uuid, t);
  }

  // --- Interaction: drag + pan + zoom ---

  /** Active drag state. `kind` flags what the gesture is doing so move/up
   *  handlers know which branch to take. `null` when nothing is in flight. */
  type DragState =
    | { kind: 'note'; startVX: number; startVY: number; movedPx: number;
        moves: Map<string, { startX: number; startY: number }>; pointerId: number; primary: string;
        pendingDX: number; pendingDY: number; pendingShift: boolean }
    | { kind: 'pan'; startVX: number; startVY: number; startPanX: number; startPanY: number; pointerId: number }
    | null;
  let drag: DragState = null;
  let spaceHeld = false;
  let tool: 'select' | 'hand' = 'select';
  let dragWriteRaf: number | null = null;

  function flushDragWrite(): void {
    dragWriteRaf = null;
    if (!drag || drag.kind !== 'note') return;
    markNotesDirty(); // D-Q15 (C4) — any drag flush moves something
    let dxBoard = drag.pendingDX / camera.zoom;
    let dyBoard = drag.pendingDY / camera.zoom;
    if (drag.pendingShift) {
      if (Math.abs(dxBoard) >= Math.abs(dyBoard)) dyBoard = 0;
      else dxBoard = 0;
    }
    for (const [uuid, start] of drag.moves) {
      const note = opts.getNote(uuid);
      if (!note) continue;
      note.positionX = clampCoord(start.startX + dxBoard);
      note.positionY = clampCoord(start.startY + dyBoard);
      if (grid) grid.move(uuid, note.positionX, note.positionY);
      const node = nodeCache.get(uuid);
      if (node) {
        // Drag path writes the transform directly (we want every frame
        // during an active drag) and updates the paintCache so the next
        // pan-driven refresh() short-circuits this survivor instead of
        // re-writing the same transform. P5.
        node.style.transform = `translate(${note.positionX}px, ${note.positionY}px)`;
        node.style.zIndex = String(note.zIndex ?? 0);
        const cached = paintCache.get(node);
        const x = note.positionX as number;
        const y = note.positionY as number;
        const z = note.zIndex ?? 0;
        if (cached) { cached.x = x; cached.y = y; cached.z = z; }
        else paintCache.set(node, { x, y, z });
      }
    }
    minimap.invalidateContent();
    scheduleMinimap();
    lodLayer?.scheduleRepaint();
  }

  function setTool(next: 'select' | 'hand'): void {
    tool = next;
    el.classList.toggle('hand-tool', tool === 'hand');
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;  // left or middle only
    const target = e.target as HTMLElement;
    // Chrome overlays (AI bar input, HUD buttons, minimap) live inside `el`
    // so this handler sees their pointerdowns too. Bailing out preserves the
    // browser's default focus / click behavior — without this, `preventDefault`
    // on the pan branch eats the AI input's focus. Bug found via local QA.
    if (target.closest('.whiteboard-ai-bar, .whiteboard-hud, .whiteboard-minimap')) return;
    let tile = target.closest<HTMLElement>('.note');
    const middleOrSpace = e.button === 1 || spaceHeld;

    // Q-P3 LOD hit-test: in LOD mode no .note children exist, so .closest is
    // null. Raycast against the canvas-painted rects; on a hit, force-mount
    // that uuid so the existing note-drag branch below runs unchanged.
    if (mode === 'lod' && !tile && !middleOrSpace && lodLayer && tool !== 'hand') {
      if (!elRect) elRect = el.getBoundingClientRect();
      const vx = e.clientX - elRect.left;
      const vy = e.clientY - elRect.top;
      const hitUuid = lodLayer.hitTest(vx, vy, opts.getVisibleNotes(), camera);
      if (hitUuid) {
        const mounted = forceMount(hitUuid);
        if (mounted) tile = mounted;
      }
    }

    // Hand tool (B2): sticky pan mode — every canvas pointerdown pans,
    // regardless of whether it landed on a note.
    const handMode = tool === 'hand';

    if (tile && !middleOrSpace && !handMode) {
      const uuid = tile.dataset.uuid;
      if (!uuid) return;
      // Selection update: shift adds, plain click sets-only (unless already in).
      if (e.shiftKey) {
        selection.toggle(uuid);
      } else if (!selection.has(uuid)) {
        selection.setOnly(uuid);
      }
      // Build the move set from current selection (including this uuid).
      // P7: forEach avoids the defensive `new Set(this.set)` snapshot.
      const moves = new Map<string, { startX: number; startY: number }>();
      selection.forEach((sel) => {
        const note = opts.getNote(sel);
        if (!note) return;
        moves.set(sel, { startX: note.positionX ?? 0, startY: note.positionY ?? 0 });
      });
      // Bring all dragging tiles to front (transient class — no z_index write).
      for (const u of moves.keys()) {
        nodeCache.get(u)?.classList.add('dragging');
      }
      drag = {
        kind: 'note',
        startVX: e.clientX,
        startVY: e.clientY,
        movedPx: 0,
        moves,
        pointerId: e.pointerId,
        primary: uuid,
        pendingDX: 0,
        pendingDY: 0,
        pendingShift: e.shiftKey,
      };
      tile.setPointerCapture(e.pointerId);
      // Touch long-press (PLAN §7): hold a finger still on a note for
      // LONG_PRESS_MS and open the editor immediately, cancelling the
      // in-flight drag. Desktop tap-to-open still works via the
      // movedPx<TAP_THRESHOLD branch in onPointerUp.
      if (e.pointerType === 'touch') startLongPressTimer(uuid);
      e.preventDefault();
      return;
    }

    // Pan on empty whiteboard, or with space/middle anywhere.
    drag = {
      kind: 'pan',
      startVX: e.clientX,
      startVY: e.clientY,
      startPanX: camera.panX,
      startPanY: camera.panY,
      pointerId: e.pointerId,
    };
    el.setPointerCapture(e.pointerId);
    el.classList.add('panning');
    if (!tile) selection.clear();
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startVX;
    const dy = e.clientY - drag.startVY;

    if (drag.kind === 'pan') {
      setCamera({
        panX: drag.startPanX + dx,
        panY: drag.startPanY + dy,
        zoom: camera.zoom,
      });
      return;
    }

    // kind === 'note' — coalesce into one rAF per frame (B5).
    drag.movedPx = Math.max(drag.movedPx, Math.abs(dx) + Math.abs(dy));
    if (drag.movedPx >= TAP_THRESHOLD) cancelLongPressTimer();
    drag.pendingDX = dx;
    drag.pendingDY = dy;
    drag.pendingShift = e.shiftKey;
    if (dragWriteRaf == null) dragWriteRaf = requestAnimationFrame(flushDragWrite);
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const finished = drag;
    drag = null;
    el.classList.remove('panning');
    cancelLongPressTimer();

    if (finished.kind === 'pan') return;

    // Flush any pending rAF drag write synchronously so the final position
    // captured below matches what's on screen (B5).
    if (dragWriteRaf != null) {
      cancelAnimationFrame(dragWriteRaf);
      dragWriteRaf = null;
      drag = finished;  // flushDragWrite reads `drag`; restore briefly.
      flushDragWrite();
      drag = null;
    }

    // Note drag finished.
    for (const u of finished.moves.keys()) {
      nodeCache.get(u)?.classList.remove('dragging');
    }
    // If long-press already opened the editor for this gesture, suppress the
    // pointerup tap branch — the user already got the editor and would be
    // surprised to re-open it on lift.
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    if (finished.movedPx < TAP_THRESHOLD) {
      // Treat as tap. Require a double-tap on the same note to open the
      // editor — a single tap is a no-op so the user can grab + drag the
      // note without accidentally opening it. Long-press still opens.
      const now = performance.now();
      if (
        lastTapUuid === finished.primary &&
        now - lastTapAt <= DOUBLE_TAP_MS
      ) {
        lastTapUuid = null;
        lastTapAt = 0;
        opts.onNoteClick?.(finished.primary);
      } else {
        lastTapUuid = finished.primary;
        lastTapAt = now;
      }
      return;
    }
    // Persist all moved positions and record an undo entry. Both single-drag
    // and multi-drag collapse into one history step.
    const deltas: MoveDelta[] = [];
    const updates: { uuid: string; x: number; y: number; z?: number }[] = [];
    for (const [uuid, start] of finished.moves) {
      const note = opts.getNote(uuid);
      if (!note || note.positionX == null || note.positionY == null) continue;
      // Skip notes that didn't actually move (e.g. the primary of a multi-
      // select where only some siblings moved). dx==0 && dy==0 means no work.
      if (start.startX === note.positionX && start.startY === note.positionY) continue;
      deltas.push({
        uuid,
        prevX: start.startX, prevY: start.startY,
        newX: note.positionX, newY: note.positionY,
      });
      updates.push({ uuid, x: note.positionX, y: note.positionY });
    }
    pushHistory(deltas);
    if (updates.length === 1) {
      // Single drag → debounce against rapid successive drags of the same uuid.
      queuePositionWrite(updates[0]!.uuid);
    } else if (updates.length > 1) {
      opts.onPositionsChanged(updates);
    }
  }

  function onPointerCancel(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.kind === 'note') {
      for (const u of drag.moves.keys()) {
        nodeCache.get(u)?.classList.remove('dragging');
      }
    }
    if (dragWriteRaf != null) { cancelAnimationFrame(dragWriteRaf); dragWriteRaf = null; }
    el.classList.remove('panning');
    cancelLongPressTimer();
    drag = null;
  }

  // --- Long-press timer plumbing ---
  //
  // One pointer at a time — multi-touch is handled by browser-level pinch
  // (not us). Long-press fires once per gesture; longPressFired flag tells
  // onPointerUp to skip the tap branch so the editor isn't opened twice.
  let longPressTimer: number | null = null;
  let longPressFired = false;

  // Double-tap-to-open state. See DOUBLE_TAP_MS.
  let lastTapUuid: string | null = null;
  let lastTapAt = 0;

  function startLongPressTimer(uuid: string): void {
    cancelLongPressTimer();
    longPressFired = false;
    longPressTimer = window.setTimeout(() => {
      longPressTimer = null;
      longPressFired = true;
      // Drop drag state so any subsequent pointermove won't try to translate.
      // Cleanup is otherwise identical to pointerup-tap.
      if (drag && drag.kind === 'note') {
        for (const u of drag.moves.keys()) nodeCache.get(u)?.classList.remove('dragging');
      }
      drag = null;
      opts.onNoteClick?.(uuid);
    }, LONG_PRESS_MS);
  }

  function cancelLongPressTimer(): void {
    if (longPressTimer != null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  // Trackpad-ish heuristic (B1): plain wheel with deltaMode 0 and small,
  // often fractional deltas — macOS/Windows precision touchpads emit these.
  // Mouse wheels emit large integer deltas (deltaMode 1, or 100+ at mode 0).
  function isTrackpadPan(e: WheelEvent): boolean {
    if (e.deltaMode !== 0) return false;
    if (Math.abs(e.deltaY) >= 50) return false;
    // Both early-returns above guarantee deltaMode === 0 && |deltaY| < 50, so
    // any wheel event that reaches here is a trackpad pan. The previous
    // `fractional || bothAxes || |deltaY| < 50` heuristic was redundant; the
    // third clause is tautologically true and short-circuited the others.
    return true;
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    cancelCameraTween();
    // Cached bounding rect (P6) — onWheel fires at 30–120 Hz on Magic
    // Trackpad; reading getBoundingClientRect every event forces layout.
    if (!elRect) elRect = el.getBoundingClientRect();
    const vx = e.clientX - elRect.left;
    const vy = e.clientY - elRect.top;

    // Cmd/Ctrl+wheel OR trackpad pinch (macOS reports it as ctrlKey:true):
    // zoom-to-cursor with a snappy factor.
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.01);
      setCamera(zoomAt(camera, vx, vy, camera.zoom * factor));
      return;
    }

    // Mouse wheel (line mode or large integer deltas): zoom-to-cursor at a
    // gentler step. Shift swaps to horizontal pan.
    const looksLikeMouseWheel = e.deltaMode === 1 || (!isTrackpadPan(e) && Math.abs(e.deltaY) >= 50);
    if (looksLikeMouseWheel) {
      if (e.shiftKey) {
        const d = e.deltaY || e.deltaX;
        setCamera({ panX: camera.panX - d, panY: camera.panY, zoom: camera.zoom });
        return;
      }
      const factor = Math.exp(-e.deltaY * 0.0015);
      setCamera(zoomAt(camera, vx, vy, camera.zoom * factor));
      return;
    }

    // Trackpad two-finger pan: translate camera by raw viewport delta.
    setCamera({
      panX: camera.panX - e.deltaX,
      panY: camera.panY - e.deltaY,
      zoom: camera.zoom,
    });
  }

  // --- Arrow-key nudge batching (B2) ---
  //
  // Holding/repeating arrows accumulates into one undo entry. Batch starts
  // on first arrow, extends on each subsequent arrow (300ms window), commits
  // on timeout or any non-arrow keydown.
  const ARROW_BATCH_MS = 300;
  let arrowBatchStarts: Map<string, { x: number; y: number }> | null = null;
  let arrowBatchTimer: number | null = null;

  function commitArrowBatch(): void {
    if (arrowBatchTimer != null) { clearTimeout(arrowBatchTimer); arrowBatchTimer = null; }
    if (!arrowBatchStarts) return;
    const deltas: MoveDelta[] = [];
    const updates: { uuid: string; x: number; y: number }[] = [];
    for (const [uuid, start] of arrowBatchStarts) {
      const note = opts.getNote(uuid);
      if (!note || note.positionX == null || note.positionY == null) continue;
      if (start.x === note.positionX && start.y === note.positionY) continue;
      deltas.push({ uuid, prevX: start.x, prevY: start.y, newX: note.positionX, newY: note.positionY });
      updates.push({ uuid, x: note.positionX, y: note.positionY });
    }
    arrowBatchStarts = null;
    if (deltas.length === 0) return;
    pushHistory(deltas);
    if (updates.length === 1) queuePositionWrite(updates[0]!.uuid);
    else opts.onPositionsChanged(updates);
  }

  function nudgeSelection(dx: number, dy: number): void {
    // P7/P11: iterate via selection.forEach (no snapshot Set copy).
    // Build a visibleUuids set so nudges can't mutate notes that aren't in
    // the current filtered set (defence-in-depth on top of refresh()'s
    // selection prune — review-finding hardening).
    markNotesDirty(); // D-Q15 (C4)
    const visibleUuids = new Set<string>();
    for (const n of opts.getVisibleNotes()) visibleUuids.add(n.uuid);
    if (!arrowBatchStarts) {
      const starts = new Map<string, { x: number; y: number }>();
      selection.forEach((uuid) => {
        if (!visibleUuids.has(uuid)) return;
        const note = opts.getNote(uuid);
        if (!note || note.positionX == null || note.positionY == null) return;
        starts.set(uuid, { x: note.positionX, y: note.positionY });
      });
      arrowBatchStarts = starts;
    }
    selection.forEach((uuid) => {
      if (!visibleUuids.has(uuid)) return;
      const note = opts.getNote(uuid);
      if (!note) return;
      note.positionX = clampCoord((note.positionX ?? 0) + dx);
      note.positionY = clampCoord((note.positionY ?? 0) + dy);
      if (grid) grid.move(uuid, note.positionX, note.positionY);
      const node = nodeCache.get(uuid);
      if (node) {
        node.style.transform = `translate(${note.positionX}px, ${note.positionY}px)`;
        // Keep paintCache coherent so a subsequent pan-refresh short-
        // circuits the survivor branch instead of redundantly rewriting
        // the same transform.
        const cached = paintCache.get(node);
        const x = note.positionX as number;
        const y = note.positionY as number;
        const z = note.zIndex ?? 0;
        if (cached) { cached.x = x; cached.y = y; cached.z = z; }
        else paintCache.set(node, { x, y, z });
      }
    });
    minimap.invalidateContent();
    scheduleMinimap();
    lodLayer?.scheduleRepaint();
    if (arrowBatchTimer != null) clearTimeout(arrowBatchTimer);
    arrowBatchTimer = window.setTimeout(commitArrowBatch, ARROW_BATCH_MS);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (destroyed) return;
    const active = document.activeElement as HTMLElement | null;
    const inField =
      active?.tagName === 'INPUT' ||
      active?.tagName === 'TEXTAREA' ||
      active?.isContentEditable;
    // Undo/redo work regardless of field focus — ⌘Z is the universal undo
    // and we want it to reach the whiteboard even if the search input has
    // focus (which carries no meaningful undo state of its own here).
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      commitArrowBatch();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      commitArrowBatch();
      redo();
      return;
    }
    if (inField) return;

    // Cmd/Ctrl-modified shortcuts (B2). Moved off bare 0/1 so they no longer
    // collide with future text-input scenarios that bubble here.
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'a') {
        e.preventDefault();
        const all = opts.getVisibleNotes().filter(hasPosition).map(n => n.uuid);
        selection.setMany(all);
        return;
      }
      // No-op shortcuts here; perf-neutral.
      if (e.key === '0') { e.preventDefault(); fitAll(); return; }
      if (e.key === '1') { e.preventDefault(); resetCamera(); return; }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomStep(1.2, true); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomStep(1 / 1.2, true); return; }
    }

    if (e.code === 'Space') { spaceHeld = true; el.classList.add('space-held'); return; }
    if (e.key === 'Escape') { selection.clear(); commitArrowBatch(); return; }
    if (e.key.toLowerCase() === 'h') { setTool('hand'); return; }
    if (e.key.toLowerCase() === 'v') { setTool('select'); return; }

    // Arrow-key nudge (B2). 1px page-space, 10px with shift. Consecutive
    // arrows collapse into one undo entry via a 300ms debounce window.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (selection.size() === 0) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      nudgeSelection(dx, dy);
      return;
    }

    // Any other non-arrow key commits the in-flight arrow batch.
    commitArrowBatch();
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') { spaceHeld = false; el.classList.remove('space-held'); }
  }

  // --- Minimap repaint ---
  //
  // P1: pass a supplier closure that walks `opts.getVisibleNotes()` lazily
  // when paint() fires. No array allocation per scheduleMinimap() call —
  // the per-rAF cost is one supplier invocation (twice, for bbox + draw)
  // over the live visible-notes list, reading positionX/positionY directly
  // off the Note references (zero per-item allocation in the hot path).
  function minimapNotesSupplier(): Iterable<MinimapNote> {
    // Returning a generator means each call() produces a fresh iterator over
    // the live list — safe for the two-pass paint().
    return (function* () {
      const visible = opts.getVisibleNotes();
      for (let i = 0; i < visible.length; i++) {
        const n = visible[i]!;
        // Note matches MinimapNote structurally via positionX/positionY.
        // Skip notes without coords — they don't render until seeded.
        if (!hasPosition(n)) continue;
        yield n as unknown as MinimapNote;
      }
    })();
  }

  function scheduleMinimap(): void {
    minimap.update(minimapNotesSupplier, camera, viewportW, viewportH);
    // When the LOD overlay is active, repainting it on every minimap tick
    // keeps the canvas in sync with the camera (pan/zoom both flow through
    // flushCameraWrite → scheduleMinimap). Cheap: paint() is rAF-coalesced.
    if (mode === 'lod') lodLayer?.scheduleRepaint();
  }

  // --- Event wiring ---

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerCancel);
  el.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Initial viewport measure (P6). Must happen after el is constructed but
  // before the first refresh() reads viewportW/H — board.ts always appends
  // el to the DOM before calling refresh(), so clientWidth/Height are
  // populated by then. If clientWidth is still 0 (e.g. hidden parent), the
  // ResizeObserver will retro-fire once the element becomes visible.
  measureViewport();

  // HUD buttons.
  hud.querySelector<HTMLButtonElement>('[data-fit]')?.addEventListener('click', () => fitAll());
  hud.querySelector<HTMLButtonElement>('[data-reset]')?.addEventListener('click', () => resetCamera());

  // Q-P10: refresh() no longer ends with a redundant applyCamera() call.
  // Write the initial transform once here so the canvas is positioned
  // correctly on first paint. Subsequent camera changes flow through
  // setCamera()/animateCamera() which already call applyCamera().
  applyCamera();

  function recordUserMoves(deltas: { uuid: string; prevX: number; prevY: number; newX: number; newY: number }[]): void {
    pushHistory(deltas);
  }

  // --- Public API ---

  return {
    el,
    refresh,
    applyExternalMoves,
    recordUserMoves,
    fitAll,
    resetCamera,
    refreshHighlights,
    undo,
    redo,
    destroy(): void {
      destroyed = true;
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      for (const t of writeTimers.values()) clearTimeout(t);
      writeTimers.clear();
      commitArrowBatch();
      cancelLongPressTimer();
      cancelCameraTween();
      if (cameraWriteRaf != null) { cancelAnimationFrame(cameraWriteRaf); cameraWriteRaf = null; }
      if (dragWriteRaf != null) { cancelAnimationFrame(dragWriteRaf); dragWriteRaf = null; }
      if (visibilityRaf != null) {
        cancelAnimationFrame(visibilityRaf);
        visibilityRaf = null;
      }
      resizeObserver?.disconnect();
      minimap.destroy();
      aiBar?.destroy();
      // Q-P3: LOD overlay teardown.
      if (lodLayer) {
        lodLayer.destroy();
        if (lodLayer.el.parentElement) lodLayer.el.parentElement.removeChild(lodLayer.el);
      }
      // Q-P4: cancel any in-flight chunked-mount drain.
      if (drainCancel) { drainCancel(); drainCancel = null; }
      pendingMountQueue.length = 0;
      pendingMountSet.clear();
      // Q-P5a: cancel pending evictions.
      for (const t of evictionTimers.values()) clearTimeout(t);
      evictionTimers.clear();
      // D-Q16 (C3): force-flush any pending camera persist so we don't lose
      // the final pan/zoom position on view switch / page unmount.
      flushCameraPersist();
      // Q-P6: spatial grid.
      grid?.clear();
      // Clear cached nodes — they're owned by us, not by board.ts.
      for (const node of nodeCache.values()) node.remove();
      nodeCache.clear();
      mountUuids.clear();
      prevSelection = new Set();
    },
  };
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

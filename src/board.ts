// Pretext-driven masonry board.
//
// Ported from @chenglou/pretext's pages/demos/masonry/index.ts (D-005) and
// adapted for our notes:
//   - sticky-note element factory in src/sticky-note.ts (D-006: measure isolated to lib/measure.ts)
//   - active-tag filter (multi-select OR) + text search compose into the visible list
//   - DOM cache keyed by uuid (notes can be added/removed; cardIndex shifts on filter)
//   - ±200px viewport buffer for scroll virtualization
//
// One layout pass = O(visible notes). Resize + scroll go through scheduleRender();
// pretext is never called from the layout loop — only on initial prepare().

import type { PreparedNote, Note } from './lib/types';
import { createStickyNote } from './sticky-note';
import { noteSearchText } from './lib/link-note';
import { acceptSuggestion, aiArrangeStream, batchUpdatePositions, rejectSuggestion } from './lib/api';
import {
  GAP, MAX_COL_WIDTH, MAX_GRID_NOTE_HEIGHT, NOTE_PADDING_X,
  capGridNoteHeight, colCountForWidth, measureNoteHeight, prepareNote,
} from './lib/measure';
import { createWhiteboard, type Whiteboard } from './whiteboard';
import { createNewspaperView } from './newspaper';

type Positioned = {
  noteUuid: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type LayoutResult = {
  positioned: Positioned[];
  totalHeight: number;
  colWidth: number;
};

export type BoardView = 'masonry' | 'list' | 'whiteboard' | 'paper';

export type CreateBoardOpts = {
  /** Called when the user clicks a note tile (outside ghost-pill controls).
   *  Receives the up-to-date Note object. Intended for opening the editor. */
  onNoteClick?: (note: Note) => void;
};

export function createBoard(initialView: BoardView = 'masonry', boardOpts: CreateBoardOpts = {}): {
  el: HTMLElement;
  /** Replace the full data set. Reprepares pretext handles for new notes only. */
  setNotes: (notes: Note[]) => void;
  /** Insert a new note at the top. Used by optimistic add. */
  prependNote: (note: Note) => void;
  /** Update the active text filter (substring, case-insensitive, debounced upstream). */
  setQuery: (query: string) => void;
  /** Update the active tag filter set (OR semantics). */
  setActiveTags: (tags: Set<string>) => void;
  /** Subscribe to changes in the visible count (for the search-bar count badge). */
  onVisibleCountChange: (cb: (shown: number, total: number) => void) => void;
  /** Re-layout (cheap). Call from window.resize / window.scroll. */
  rerender: () => void;
  /** Snapshot of current notes (without the pretext handle). For pills repaint. */
  getNotes: () => Note[];
  /** Switch between masonry and chronological-list render modes. D-031. */
  setView: (v: BoardView) => void;
  /** Show or hide pending-suggestion ghost pills. Forces a full re-render. */
  setShowSuggestions: (show: boolean) => void;
  /** User accepted a specific pending tag. Optimistic; server call in flight. */
  acceptSuggestionTag: (uuid: string, tag: string) => void;
  /** User rejected a specific pending tag. Optimistic; server call in flight. */
  rejectSuggestionTag: (uuid: string, tag: string) => void;
  /** Apply an edit (text + re-derived tags + new updatedAt) to a single note.
   *  Mutates local state, evicts the cached DOM node, and re-renders. */
  applyNoteUpdate: (uuid: string, patch: Partial<Note> & Pick<Note, 'text' | 'tags' | 'updatedAt'>) => void;
  /** Remove a note from local state, evict its DOM, and re-render. Used by
   *  the editor's delete button (optimistic; server call is fire-and-log). */
  removeNote: (uuid: string) => void;
} {
  const el = document.createElement('div');
  el.className = containerClassFor(initialView);

  // Click delegation: note tiles open the existing editor. Ghost pills still
  // short-circuit.
  el.addEventListener('click', (e) => {
    if (!boardOpts.onNoteClick) return;
    const target = e.target as HTMLElement;
    if (target.closest('.tag-ghost')) return;
    const tile = target.closest<HTMLElement>('.note');
    if (!tile) return;
    const uuid = tile.dataset.uuid;
    if (!uuid) return;
    const note = allNotes.find(n => n.uuid === uuid);
    if (!note) return;
    const { prepared: _p, ...plain } = note;
    boardOpts.onNoteClick(plain);
  });

  let allNotes: PreparedNote[] = [];
  let visibleNotes: PreparedNote[] = [];
  let query = '';
  let activeTags = new Set<string>();
  let view: BoardView = initialView;
  let showSuggestions = true;   // default ON; toggled by header
  /** Whiteboard renderer; lazily constructed on first switch to that view
   *  so users who never enter whiteboard mode don't pay the wiring cost. */
  let whiteboard: Whiteboard | null = null;
  let newspaper: ReturnType<typeof createNewspaperView> | null = null;

  // DOM cache: uuid → node. Nodes are removed when out of viewport.
  const nodeCache = new Map<string, HTMLElement>();
  let rafId: number | null = null;
  let countCb: ((shown: number, total: number) => void) | null = null;

  // --- Filter ---

  function recomputeVisible() {
    const q = query.toLowerCase();
    visibleNotes = allNotes.filter(n => {
      if (activeTags.size > 0 && !n.tags.some(t => activeTags.has(t))) return false;
      if (q && !noteSearchText(n).toLowerCase().includes(q)) return false;
      return true;
    });
    if (countCb) countCb(visibleNotes.length, allNotes.length);
  }

  // --- Layout ---

  function computeLayout(viewportWidth: number): LayoutResult {
    const colCount = colCountForWidth(viewportWidth);
    let colWidth: number;
    if (colCount === 1) {
      colWidth = Math.min(MAX_COL_WIDTH * 1.2, viewportWidth - GAP * 2);
    } else {
      colWidth = Math.min(MAX_COL_WIDTH, (viewportWidth - (colCount + 1) * GAP) / colCount);
    }
    const textWidth = colWidth - NOTE_PADDING_X * 2;
    const contentWidth = colCount * colWidth + (colCount - 1) * GAP;
    const offsetLeft = Math.max(0, (viewportWidth - contentWidth) / 2);

    const colHeights = new Float64Array(colCount);
    const positioned: Positioned[] = [];

    for (let i = 0; i < visibleNotes.length; i++) {
      const n = visibleNotes[i]!;
      let shortest = 0;
      for (let c = 1; c < colCount; c++) {
        if (colHeights[c]! < colHeights[shortest]!) shortest = c;
      }
      const fullHeight = measureNoteHeight(n.prepared, textWidth);
      const h = capGridNoteHeight(fullHeight);
      positioned.push({
        noteUuid: n.uuid,
        x: offsetLeft + shortest * (colWidth + GAP),
        y: colHeights[shortest]!,
        width: colWidth,
        height: h,
      });
      colHeights[shortest]! += h + GAP;
    }

    let totalHeight = 0;
    for (let c = 0; c < colCount; c++) {
      if (colHeights[c]! > totalHeight) totalHeight = colHeights[c]!;
    }
    return { positioned, totalHeight, colWidth };
  }

  function render() {
    rafId = null;
    if (view === 'paper') {
      renderPaper();
      return;
    }

    if (visibleNotes.length === 0) {
      // Empty state — clear DOM, show placeholder.
      for (const node of nodeCache.values()) node.remove();
      nodeCache.clear();
      el.style.height = '';
      if (!el.querySelector('.empty')) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = query ? `NO MATCHES FOR "${query}"` : 'EMPTY';
        el.appendChild(empty);
      }
      return;
    }
    el.querySelector('.empty')?.remove();

    // D-031: list mode skips masonry layout entirely. All visible notes flow
    // in DOM (no virtualization). CSS .notes--list overrides .note inline styles.
    if (view === 'list') {
      renderList();
      return;
    }

    // Whiteboard: delegate rendering entirely to createWhiteboard(). It owns
    // its own node cache and DOM nodes — board.ts only forwards visibleNotes.
    if (view === 'whiteboard') {
      renderWhiteboard();
      return;
    }

    const viewportWidth = el.clientWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const scrollTop = window.scrollY;
    // Note positions are relative to the .notes container, not to the page.
    const elTop = el.getBoundingClientRect().top + scrollTop;

    const layout = computeLayout(viewportWidth);
    el.style.height = `${layout.totalHeight}px`;

    const viewTop = scrollTop - elTop - 200;
    const viewBottom = scrollTop - elTop + viewportHeight + 200;
    const visibleNow = new Set<string>();

    for (const p of layout.positioned) {
      if (p.y > viewBottom || p.y + p.height < viewTop) continue;
      visibleNow.add(p.noteUuid);
      let node = nodeCache.get(p.noteUuid);
      if (!node) {
        const note = allNotes.find(n => n.uuid === p.noteUuid)!;
        node = createStickyNote(note, activeTags, stickyOpts);
        el.appendChild(node);
        nodeCache.set(p.noteUuid, node);
      } else {
        // Update matched-tag highlighting if the active filter changed.
        refreshNodeHighlights(node, activeTags);
      }
      const note = allNotes.find(n => n.uuid === p.noteUuid)!;
      const clipped = measureNoteHeight(note.prepared, p.width - NOTE_PADDING_X * 2) > MAX_GRID_NOTE_HEIGHT;
      node.dataset.clipped = clipped ? 'true' : 'false';
      node.style.transform = `translate(${p.x}px, ${p.y}px)`;
      node.style.width = `${p.width}px`;
      node.style.height = `${p.height}px`;
    }

    // Evict offscreen nodes.
    for (const [uuid, node] of nodeCache) {
      if (!visibleNow.has(uuid)) {
        node.remove();
        nodeCache.delete(uuid);
      }
    }
  }

  /** Whiteboard mode (PLAN-whiteboard.md). Lazily constructs the whiteboard
   *  on first entry, then mounts/refreshes it inside `el`. board.ts retains
   *  ownership of `visibleNotes`; the whiteboard reads through callbacks. */
  function renderWhiteboard(): void {
    if (!whiteboard) {
      whiteboard = createWhiteboard({
        getVisibleNotes: () => visibleNotes,
        // D-Q9 (C9): expose the live active-tag filter so whiteboard notes
        // get the same `.matched` underline as masonry/list. Filter changes
        // call `whiteboard.refreshHighlights()` below — no remount needed.
        getActiveTags: () => activeTags,
        getNote: (uuid) => allNotes.find(n => n.uuid === uuid),
        onPositionsChanged: (updates) => {
          // Fire-and-log. On failure we keep the optimistic local state and
          // log; a reload will reconcile from the server. The server caps the
          // batch at 500; we never send more.
          void batchUpdatePositions(updates).then(ok => {
            if (!ok) console.warn('[board] position write failed', updates.length);
          });
        },
        onNoteClick: (uuid) => {
          if (!boardOpts.onNoteClick) return;
          const note = allNotes.find(n => n.uuid === uuid);
          if (!note) return;
          const { prepared: _p, ...plain } = note;
          boardOpts.onNoteClick(plain);
        },
        aiArrange: async (prompt, onEvent) => {
          // Snapshot pre-AI positions BEFORE we mutate so we can record an
          // undo entry. AI arrange is a user-initiated batch — the user
          // expects ⌘Z to reverse it (workflow-review BUG-1 fix).
          // Stream variant: every progress event from the server is piped
          // up to the AI bar's toast stack via `onEvent`.
          const result = await aiArrangeStream(prompt, onEvent);
          if (!result) return null;
          // Capture prev positions BEFORE applyExternalMoves mutates them.
          // applyExternalMoves is the single owner of the local Note mutation
          // (it runs the same clampCoord the persisted path uses, so the
          // undo record's newX/newY exactly match what's in memory —
          // review-finding fix for the off-by-clamp inconsistency at extreme
          // coordinates).
          const prevByUuid = new Map<string, { x: number; y: number }>();
          for (const u of result.updates) {
            const note = allNotes.find(n => n.uuid === u.uuid);
            if (!note) continue;
            prevByUuid.set(u.uuid, { x: note.positionX ?? 0, y: note.positionY ?? 0 });
          }
          // Repaint whiteboard with the new positions. This is now the only
          // writer of note.positionX/Y for this batch — see comment above.
          whiteboard?.applyExternalMoves(result.updates);
          // Build the delta list AFTER the mutation so newX/newY reflect the
          // clamped values actually committed in memory.
          const deltas: { uuid: string; prevX: number; prevY: number; newX: number; newY: number }[] = [];
          for (const u of result.updates) {
            const prev = prevByUuid.get(u.uuid);
            if (!prev) continue;
            const note = allNotes.find(n => n.uuid === u.uuid);
            if (!note || note.positionX == null || note.positionY == null) continue;
            deltas.push({
              uuid: u.uuid,
              prevX: prev.x, prevY: prev.y,
              newX: note.positionX, newY: note.positionY,
            });
          }
          // Record one undo entry covering the whole AI batch.
          if (deltas.length > 0) whiteboard?.recordUserMoves(deltas);
          if (result.updates.length > 0) {
            void batchUpdatePositions(result.updates).then(ok => {
              if (!ok) console.warn('[board] AI batch persist failed', result.updates.length);
            });
          }
          return { explanation: result.explanation, moved: result.updates.length };
        },
      });
    }
    if (whiteboard.el.parentElement !== el) {
      // Hide other-mode children. Whiteboard owns its own canvas.
      for (const child of Array.from(el.children)) child.remove();
      el.appendChild(whiteboard.el);
      // Clear the masonry/list node cache — those nodes are gone from the DOM.
      nodeCache.clear();
      el.style.height = '';
    }
    whiteboard.refresh();
  }

  function renderPaper(): void {
    if (!newspaper) {
      newspaper = createNewspaperView({
        onOpenNote: (uuid) => {
          if (!boardOpts.onNoteClick) return;
          const note = allNotes.find(n => n.uuid === uuid);
          if (!note) return;
          const { prepared: _p, ...plain } = note;
          boardOpts.onNoteClick(plain);
        },
      });
    }
    if (newspaper.el.parentElement !== el) {
      for (const child of Array.from(el.children)) child.remove();
      el.appendChild(newspaper.el);
      nodeCache.clear();
      el.style.height = '';
    }
    newspaper.render(visibleNotes.map(({ prepared: _p, ...note }) => note));
  }

  /** List mode (D-031). Single-pass: mount every visible note in flow order.
   *  No measurement, no positioning, no scroll virtualization. CSS
   *  `.notes--list .note` overrides masonry's inline transform/width/height.
   *  At 2,397 notes this paints in well under 500ms on modern hardware (T-031). */
  function renderList() {
    el.style.height = '';
    const visibleNow = new Set<string>();
    for (const n of visibleNotes) {
      visibleNow.add(n.uuid);
      let node = nodeCache.get(n.uuid);
      if (!node) {
        node = createStickyNote(n, activeTags, stickyOpts);
        // CSS will override these but clear them anyway so masonry's stale
        // inline transform/width/height from a prior render don't linger.
        node.style.transform = '';
        node.style.width = '';
        node.style.height = '';
        node.dataset.clipped = 'false';
        el.appendChild(node);
        nodeCache.set(n.uuid, node);
      } else {
        // Already mounted (e.g. survivor across mode toggle). Keep DOM order
        // aligned with visibleNotes so filter changes don't shuffle visually.
        if (node.parentElement !== el || node.previousSibling?.nextSibling !== node) {
          el.appendChild(node);  // appendChild re-inserts; cheap, no flicker.
        }
        node.style.transform = '';
        node.style.width = '';
        node.style.height = '';
        node.dataset.clipped = 'false';
        refreshNodeHighlights(node, activeTags);
      }
    }
    // Evict notes no longer in visibleNotes (filter changed).
    for (const [uuid, node] of nodeCache) {
      if (!visibleNow.has(uuid)) {
        node.remove();
        nodeCache.delete(uuid);
      }
    }
  }

  function scheduleRender() {
    if (rafId != null) return;
    rafId = requestAnimationFrame(render);
  }

  // Sticky-note options bundle: passed on every createStickyNote() call. The
  // identity-stable closure functions below (`onAccept`/`onReject`) mean we
  // don't have to rebuild the opts object per node.
  const stickyOpts = {
    get showSuggestions() { return showSuggestions; },
    onAccept: (uuid: string, tag: string) => acceptSuggestionTagImpl(uuid, tag),
    onReject: (uuid: string, tag: string) => rejectSuggestionTagImpl(uuid, tag),
  };

  // --- Suggestion lifecycle ---

  /** Evict a single note's cached DOM so the next render rebuilds it. Used
   *  after a mutation that changes tags or pending-suggestion shape. */
  function evictNode(uuid: string) {
    const node = nodeCache.get(uuid);
    if (node) {
      node.remove();
      nodeCache.delete(uuid);
    }
  }

  /** Optimistically accept `tag` for `uuid`: merge into note.tags, drop from
   *  pendingSuggestion.tags, clear pendingSuggestion if it empties out. Per
   *  the server contract, ANY accept call closes the suggestion row (the
   *  unselected pending tags are abandoned) — we mirror that locally to
   *  match server state. */
  function acceptSuggestionTagImpl(uuid: string, tag: string) {
    const note = allNotes.find(n => n.uuid === uuid);
    if (!note) return;
    if (!note.tags.includes(tag)) note.tags = [...note.tags, tag];
    // Server closes the row on any accept → clear local pendingSuggestion entirely.
    note.pendingSuggestion = undefined;
    evictNode(uuid);
    recomputeVisible();
    scheduleRender();
    // Server call (fire-and-log). On failure we leave the optimistic state —
    // page reload will reconcile. TODO: surface a toast on persistent failure.
    void acceptSuggestion(uuid, [tag]).then(updated => {
      if (!updated) {
        console.warn('[board] acceptSuggestion returned null for', uuid, tag);
      }
    });
  }

  /** Optimistically reject `tag` for `uuid`: drop from pendingSuggestion.tags;
   *  clear pendingSuggestion if it empties out. notes.tags is never touched. */
  function rejectSuggestionTagImpl(uuid: string, tag: string) {
    const note = allNotes.find(n => n.uuid === uuid);
    if (!note || !note.pendingSuggestion) return;
    const remaining = note.pendingSuggestion.tags.filter(t => t !== tag);
    if (remaining.length === 0) {
      note.pendingSuggestion = undefined;
    } else {
      // Re-anchor primary if it was the rejected tag (mirrors server behavior).
      const primary = remaining.includes(note.pendingSuggestion.primary)
        ? note.pendingSuggestion.primary
        : remaining[0]!;
      note.pendingSuggestion = {
        ...note.pendingSuggestion,
        tags: remaining,
        primary,
      };
    }
    evictNode(uuid);
    scheduleRender();
    void rejectSuggestion(uuid, [tag]).then(updated => {
      if (!updated) {
        console.warn('[board] rejectSuggestion returned null for', uuid, tag);
      }
    });
  }

  // --- Lifecycle ---

  function refreshNodeHighlights(node: HTMLElement, active: Set<string>) {
    const tags = node.querySelectorAll<HTMLElement>('.tag-mini');
    tags.forEach(t => {
      if (active.has(t.textContent ?? '')) t.classList.add('matched');
      else t.classList.remove('matched');
    });
  }

  function clearAllNodes() {
    for (const node of nodeCache.values()) node.remove();
    nodeCache.clear();
  }

  function clearRenderedChildren() {
    for (const child of Array.from(el.children)) child.remove();
    nodeCache.clear();
  }

  // --- Public API ---

  return {
    el,
    setNotes(notes) {
      // Preserve prepared handles for notes we've already seen.
      const prevByUuid = new Map(allNotes.map(n => [n.uuid, n]));
      allNotes = notes.map(n => prevByUuid.get(n.uuid) ?? prepareNote(n));
      clearAllNodes();
      recomputeVisible();
      scheduleRender();
    },
    prependNote(note) {
      const prepared = prepareNote(note);
      allNotes = [prepared, ...allNotes];
      recomputeVisible();
      scheduleRender();
    },
    setQuery(q) { query = q; recomputeVisible(); scheduleRender(); },
    setActiveTags(tags) {
      activeTags = tags;
      // D-Q9 (C9): refresh existing whiteboard-mode highlights in place
      // (zero createStickyNote calls) and trigger the regular render. If
      // the whiteboard isn't constructed yet (masonry-mode session) this
      // no-ops cheaply.
      whiteboard?.refreshHighlights();
      recomputeVisible();
      scheduleRender();
    },
    onVisibleCountChange(cb) {
      countCb = cb;
      // Fire immediately so the badge has a starting value.
      cb(visibleNotes.length, allNotes.length);
    },
    rerender: scheduleRender,
    getNotes() {
      return allNotes.map(({ prepared: _p, ...n }) => n);
    },
    setView(v) {
      if (v === view) return;
      const prev = view;
      view = v;
      // Container class encodes which CSS scope is active.
      el.className = containerClassFor(v);
      // Switching modes invalidates the masonry's inline styles vs list's flow
      // vs whiteboard's transform — clear cached nodes so the next render
      // rebuilds from scratch under the correct mode.
      clearRenderedChildren();
      // Leaving whiteboard: tear down the whiteboard fully — detach DOM,
      // call destroy() so the window-level keydown/keyup listeners, pointer
      // handlers, pending position-write timers, and the minimap rAF are
      // all released. Next entry rebuilds from scratch (cheap; ~ms-scale).
      // Without this, every masonry↔list↔whiteboard cycle leaked a set of
      // listeners + timers.
      if (prev === 'whiteboard' && whiteboard) {
        if (whiteboard.el.parentElement === el) el.removeChild(whiteboard.el);
        whiteboard.destroy();
        whiteboard = null;
      }
      scheduleRender();
    },
    setShowSuggestions(show) {
      if (show === showSuggestions) return;
      showSuggestions = show;
      // Ghost pills live inside the caption; toggling visibility means every
      // cached node has stale DOM. Cheapest correct thing: nuke the cache and
      // let the next render rebuild from scratch.
      clearAllNodes();
      scheduleRender();
    },
    acceptSuggestionTag: acceptSuggestionTagImpl,
    rejectSuggestionTag: rejectSuggestionTagImpl,
    removeNote(uuid) {
      const idx = allNotes.findIndex(n => n.uuid === uuid);
      if (idx === -1) return;
      allNotes.splice(idx, 1);
      evictNode(uuid);
      recomputeVisible();
      scheduleRender();
    },
    applyNoteUpdate(uuid, patch) {
      const idx = allNotes.findIndex(n => n.uuid === uuid);
      if (idx === -1) return;
      const prev = allNotes[idx]!;
      // Re-prepare since text changed (pretext measurement depends on it).
      const next: PreparedNote = prepareNote({
        ...prev,
        ...patch,
        text: patch.text,
        tags: patch.tags,
        updatedAt: patch.updatedAt,
      });
      // Preserve pendingSuggestion if any — PATCH does not touch the suggestion row.
      if (prev.pendingSuggestion) next.pendingSuggestion = prev.pendingSuggestion;
      allNotes[idx] = next;
      // Only reshuffle when the content timestamp actually changed. Tag-only
      // edits preserve `updatedAt`, so keep the note in place.
      if (idx !== 0 && next.updatedAt !== prev.updatedAt) {
        allNotes.splice(idx, 1);
        allNotes.unshift(next);
      }
      evictNode(uuid);
      recomputeVisible();
      scheduleRender();
    },
  };
}

/** Map a BoardView to its `.notes` container class list. Single source of
 *  truth for the CSS scope used by each view (D-031 list mode and the
 *  2026-06-06 whiteboard mode both layer over `.notes`). */
function containerClassFor(view: BoardView): string {
  switch (view) {
    case 'list':       return 'notes notes--list';
    case 'whiteboard': return 'notes notes--whiteboard';
    case 'paper':      return 'notes notes--paper';
    case 'masonry':    return 'notes';
  }
}

/** Attach the resize + scroll listeners that drive the masonry. */
export function attachWindowListeners(board: ReturnType<typeof createBoard>): () => void {
  const onResize = () => board.rerender();
  const onScroll = () => board.rerender();
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll);
  };
}

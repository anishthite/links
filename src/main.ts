// Entry point. Boots the masonry board against either /api/notes (when running
// under wrangler) or sample data (when running under vite alone). See D-025.
//
// Chrome (D-029): one header row with 3 controls (search, +, filter). Old
// four-stack (masthead + add-box + search + pills) was retired in favor of
// a single header that owns popovers for write + pills.
//
// Render gate: pretext measurement is inaccurate before fonts load, so we await
// document.fonts.ready before the first prepare() (D-007).

import './styles/globals.css';
import './styles/board.css';

import { attachWindowListeners, createBoard } from './board';
import { createHeader, type BoardView } from './header';
import { createAgentView } from './agent-view';
import { createNote, deleteNote, findSimilarNotes, getNotes, isFallback, refreshLinkSource, updateNote } from './lib/api';
import { createNoteEditor } from './note-editor';
import { uniqueTagsFromNotes } from './lib/tags';
import type { Note } from './lib/types';

// --- PERF HARNESS (dev-only) ---
// `?perf=N` synthesizes N in-memory notes routed through the live
// visibleNotes pipeline. Skips all network fetches. Gated by import.meta.env.DEV
// so this code is dropped from prod bundles.
function perfQueryCount(): number | null {
  try {
    const p = new URLSearchParams(window.location.search);
    const raw = p.get('perf');
    if (!raw) return null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(n, 100_000);
  } catch { return null; }
}
function perfQueryView(): BoardView | null {
  try {
    const v = new URLSearchParams(window.location.search).get('view');
    if (v === 'whiteboard' || v === 'masonry' || v === 'list' || v === 'agent') return v;
    return null;
  } catch { return null; }
}
function synthPerfNotes(n: number): Note[] {
  const TAGS = ['idea','todo','infra','thought','people','reminder','board','hot-take','shop','lesson','perf','wip'];
  const WORDS = ['the','a','quick','brown','fox','jumps','over','lazy','dog','sticky','note','board','whiteboard','perf','test','idea','tag','line','colour','position','render','frame','drag','zoom','pan','virtualize','mount','evict','baseline','measure','seed','grid','plan','ship','done','open'];
  // Seeded PRNG so each (N) run gives identical positions.
  let s = 1337 ^ n;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: Note[] = [];
  const now = Date.now();
  // Distribute across a 6000×6000 board-space area.
  // Grid cell size matches SEED_CELL_WIDTH (280) so we still exercise the
  // pipeline if we ever seed-layout, but we hand-place every note so
  // hasAnyUnplaced fast-paths to false on first refresh.
  const cols = Math.ceil(Math.sqrt(n));
  const cell = Math.floor(6000 / Math.max(1, cols));
  for (let i = 0; i < n; i++) {
    const wordCount = 4 + Math.floor(rng() * 16);
    const words: string[] = [];
    for (let w = 0; w < wordCount; w++) words.push(WORDS[Math.floor(rng() * WORDS.length)]!);
    // ~10% notes get a newline to exercise multi-line measurement.
    if (rng() < 0.10) words.splice(Math.floor(wordCount / 2), 0, '\n');
    const text = words.join(' ');
    const tagCount = 1 + Math.floor(rng() * 3);
    const tagSet = new Set<string>();
    for (let t = 0; t < tagCount; t++) tagSet.add(TAGS[Math.floor(rng() * TAGS.length)]!);
    const tags = Array.from(tagSet);
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Add jitter so notes don't perfectly align — exercises real virtualization.
    const jitterX = Math.floor((rng() - 0.5) * 40);
    const jitterY = Math.floor((rng() - 0.5) * 40);
    out.push({
      uuid: `perf-${i.toString(36)}`,
      text,
      tags,
      color: null,
      createdAt: now - i * 1000,
      updatedAt: now - i * 1000,
      positionX: col * cell + jitterX,
      positionY: row * cell + jitterY,
    });
  }
  return out;
}

// D-032: persisted view mode. Read once on boot, written on every toggle.
// Default 'masonry'; unrecognized values normalize to 'masonry' too.
// 'whiteboard' added 2026-06-06 (see PLAN-whiteboard.md), hidden from normal
// navigation 2026-06-16: stale saved values fall back to masonry.
const VIEW_STORAGE_KEY = 'boardView';
function loadInitialView(): BoardView {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    if (v === 'list' || v === 'agent') return v;
    return 'masonry';
  } catch {
    return 'masonry';
  }
}
function applyViewBodyClass(view: BoardView) {
  const body = document.body;
  body.classList.toggle('view-whiteboard', view === 'whiteboard');
  body.classList.toggle('view-masonry', view === 'masonry');
  body.classList.toggle('view-list', view === 'list');
  body.classList.toggle('view-agent', view === 'agent');
}
function toBoardView(view: BoardView): 'masonry' | 'list' | 'whiteboard' {
  return view === 'agent' ? 'masonry' : view;
}

function persistView(v: BoardView) {
  try { localStorage.setItem(VIEW_STORAGE_KEY, v); } catch { /* private-mode etc. */ }
}

// Pending-suggestion ghost pills: opt-out toggle. Default ON.
// Stored as '0' (off) / '1' (on); missing key → ON.
const SUGG_STORAGE_KEY = 'boardShowSuggestions';
function loadInitialShowSuggestions(): boolean {
  try { return localStorage.getItem(SUGG_STORAGE_KEY) !== '0'; }
  catch { return true; }
}
function persistShowSuggestions(show: boolean) {
  try { localStorage.setItem(SUGG_STORAGE_KEY, show ? '1' : '0'); } catch { /* private-mode */ }
}

async function main() {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app not found');

  const main = document.createElement('main');
  main.className = 'board';
  root.appendChild(main);

  const initialView = loadInitialView();
  applyViewBodyClass(initialView);
  const initialShowSuggestions = loadInitialShowSuggestions();

  // Shared live read of the existing-tag universe for chip-strip autocomplete.
  // Uses board.getNotes() so freshly added tags surface immediately without
  // a reload (D-4 in implementation-notes/2026-05-29-tag-chips.html).
  const getAllTags = (): string[] => uniqueTagsFromNotes(board.getNotes());

  let openAgentFromNote = (_note: Note) => {};

  // Editor: single overlay instance. Defined before the board so we can pass
  // its open() in via onNoteClick.
  const editor = createNoteEditor({
    getAllTags,
    onSave: async (uuid, patch) => {
      const updated = await updateNote(uuid, patch);
      if (updated) {
        board.applyNoteUpdate(uuid, updated);
        header.setNotes(board.getNotes());
      }
      return updated;
    },
    onDelete: async (uuid) => {
      const ok = await deleteNote(uuid);
      if (ok) {
        board.removeNote(uuid);
        header.setNotes(board.getNotes());
      }
      return ok;
    },
    onStartChat: (note) => openAgentFromNote(note),
    onRefreshLink: async (uuid) => {
      const updated = await refreshLinkSource(uuid);
      if (updated) {
        board.applyNoteUpdate(uuid, updated);
        header.setNotes(board.getNotes());
      }
      return updated;
    },
  });

  // Build the board first so we can wire callbacks; mount it after the header.
  const board = createBoard(toBoardView(initialView), {
    onNoteClick: (note) => editor.open(note),
  });
  const agentView = createAgentView({
    getAllTags,
    onNoteSaved: (note) => {
      board.prependNote(note);
      header.setNotes(board.getNotes());
    },
    onOpenSource: (uuid) => {
      const note = board.getNotes().find((entry) => entry.uuid === uuid);
      if (note) editor.open(note);
    },
  });
  // Apply initial suggestions visibility before first paint.
  board.setShowSuggestions(initialShowSuggestions);

  let headerApi: { setView: (view: BoardView) => void } | null = null;
  const switchView = (view: BoardView, syncHeader = true) => {
    persistView(view);
    applyViewBodyClass(view);
    const showAgent = view === 'agent';
    board.el.hidden = showAgent;
    agentView.el.hidden = !showAgent;
    if (!showAgent) {
      board.setView(toBoardView(view));
      board.rerender();
    }
    if (syncHeader) headerApi?.setView(view);
  };
  openAgentFromNote = (note) => {
    switchView('agent');
    void agentView.startFromNote(note);
  };

  const header = createHeader({
    getAllTags,
    onSearch: (q) => board.setQuery(q),
    onAddNote: async (input) => {
      const note = await createNote(input);
      if (note) {
        const existing = board.getNotes().find((entry) => entry.uuid === note.uuid);
        if (existing) board.applyNoteUpdate(note.uuid, note);
        else board.prependNote(note);
        header.setNotes(board.getNotes());
      }
      return note;
    },
    onUpdateNote: async (uuid, patch) => {
      const updated = await updateNote(uuid, patch);
      if (updated) {
        board.applyNoteUpdate(uuid, updated);
        header.setNotes(board.getNotes());
      }
      return updated;
    },
    onFilterChange: (active) => board.setActiveTags(active),
    onViewChange: (view) => {
      switchView(view, false);
    },
    onShowSuggestionsChange: (show) => {
      persistShowSuggestions(show);
      board.setShowSuggestions(show);
    },
    onFindSimilarNotes: (text, tags, limit) => findSimilarNotes(text, tags, limit),
    onOpenNote: (uuid) => {
      const note = board.getNotes().find((entry) => entry.uuid === uuid);
      if (note) editor.open(note);
    },
    initialView,
    initialShowSuggestions,
  });
  headerApi = header;
  main.appendChild(header.el);

  main.appendChild(board.el);
  main.appendChild(agentView.el);
  board.el.hidden = initialView === 'agent';
  agentView.el.hidden = initialView !== 'agent';

  // Editor mounts at document.body so its fixed-position backdrop covers the
  // whole viewport regardless of where .board sits.
  editor.mount(document.body);

  const footer = document.createElement('footer');
  footer.className = 'board-footer';
  footer.innerHTML = `<span data-mode>booting…</span>`;
  main.appendChild(footer);

  board.onVisibleCountChange((shown, total) => {
    header.setCount(shown, total);
  });

  // Wait for fonts before measurement (pretext requires this).
  await document.fonts.ready;

  // Perf harness branch — synthesize in-memory notes, no network.
  const perfN = import.meta.env.DEV ? perfQueryCount() : null;
  const perfView = perfQueryView();
  if (perfN != null) {
    if (perfView && perfView !== initialView) {
      applyViewBodyClass(perfView);
      board.el.hidden = perfView === 'agent';
      agentView.el.hidden = perfView !== 'agent';
      if (perfView !== 'agent') board.setView(toBoardView(perfView));
      header.setView(perfView);
    }
    const t0 = performance.now();
    const notes = synthPerfNotes(perfN);
    const t1 = performance.now();
    board.setNotes(notes);
    const t2 = performance.now();
    header.setNotes(notes);
    header.setCount(notes.length, notes.length);
    // Expose a tiny API so the perf harness can introspect counts and force
    // re-renders / view switches from the outside.
    (window as unknown as { __perf?: unknown }).__perf = {
      n: notes.length,
      synthMs: t1 - t0,
      setNotesMs: t2 - t1,
      getBoard: () => board,
      // Returns visible-note count for the current filter (sanity).
      visibleCount: () => board.getNotes().length,
    };
    console.log('[perf] harness ready', { n: notes.length, synthMs: t1 - t0, setNotesMs: t2 - t1 });
  } else {
    const notes = await getNotes();
    board.setNotes(notes);
    header.setNotes(notes);
    header.setCount(notes.length, notes.length);
  }

  const modeEl = footer.querySelector<HTMLElement>('[data-mode]')!;
  modeEl.textContent = isFallback() ? 'local · sample data' : 'connected · d1';

  attachWindowListeners(board);
}

main().catch(err => {
  console.error('[board] boot failed', err);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = `<div style="padding:48px;font-family:system-ui">
      <h1 style="font-weight:300">Something broke.</h1>
      <pre style="background:#fee;padding:12px;border-radius:4px;overflow:auto">${String(err)}</pre>
    </div>`;
  }
});

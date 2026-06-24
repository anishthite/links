// Header: one row, three controls. Replaces the four-stack
// (masthead + add-box + search + pills) from the v0 chrome.
//
//   ┌─────────────────────────────────────────────────────┐
//   │ [search…                              N]  +   ⌑(k) │
//   └─────────────────────────────────────────────────────┘
//
// + opens a write panel below the row; ⌑ opens the pills panel below
// the row. Both panels stack independently. See D-029 in implementation-notes.
//
// Keyboard:
//   /     → focus search (when not already in an input)
//   ⌘N    → open write panel + focus textarea
//   ⌘F    → focus search (Mac convention)
//   Esc   → close whichever panel is open, or blur+clear search
//
// Save is an explicit button click (the ⌘+↵ keybinding was removed so the
// UI works the same on desktop and mobile — touch users had no way to invoke
// the shortcut). See implementation-notes/2026-05-29-save-button.html.
//
// Structure: `createHeader` is the composition root — it builds the DOM via
// one innerHTML template, owns shared state (notes, active filter set,
// search/filter open-flags), and registers the global keydown listener.
// Self-contained sections are extracted into module-scope sub-factories
// declared below (Theme, View, Suggestions, Write). Search and Filter
// stay inline in `createHeader` because they share `active: Set<string>`
// (search's setCount reads it; filter pills mutate it). See D-303, D-306.

import type { Note, SimilarNote } from './lib/types';
import { tagColor } from './lib/colors';
import { isFallback } from './lib/api';
import { escapeHtml, escapeAttr } from './lib/html-escape';
import { noteDisplayTitle, notePreviewText, noteSourceHost } from './lib/link-note';
import { createTagChips } from './tag-chips';

export type BoardView = 'masonry' | 'list' | 'whiteboard' | 'agent';

type NoteWriteResult = Note | null | void;

type HeaderOpts = {
  onSearch: (query: string) => void;
  onAddNote: (input: { text: string; tags: string[]; sourceUrl?: string }) => Promise<NoteWriteResult> | NoteWriteResult;
  onUpdateNote: (uuid: string, patch: { text: string; tags: string[] }) => Promise<NoteWriteResult> | NoteWriteResult;
  onFilterChange: (active: Set<string>) => void;
  onViewChange: (view: BoardView) => void;
  initialView: BoardView;
  /** Called when the user toggles "show pending suggestions" in the filter panel. */
  onShowSuggestionsChange?: (show: boolean) => void;
  /** Initial state for the pending-suggestions toggle. Default: true. */
  initialShowSuggestions?: boolean;
  /** Live read of all known tags for the chip-strip autocomplete in the write panel. */
  getAllTags: () => string[];
  /** On-demand related-note lookup for expanded write mode. */
  onFindSimilarNotes?: (text: string, tags: string[], limit?: number) => Promise<SimilarNote[]>;
  /** Open an existing note from the similar-notes sidebar. */
  onOpenNote?: (uuid: string) => void;
};

// --- createHeader (composition root) ---

export function createHeader(opts: HeaderOpts): {
  el: HTMLElement;
  setNotes: (notes: Note[]) => void;             // for pills repaint + pending count
  setCount: (shown: number, total: number) => void;
  getActive: () => Set<string>;
  setView: (v: BoardView) => void;
  getShowSuggestions: () => boolean;
} {
  const el = document.createElement('header');
  el.className = 'header';
  el.innerHTML = `
    <div class="header-row">
      <label class="searchbox" data-searchbox>
        <input type="search" placeholder="search links…" aria-label="search links" autocomplete="off">
        <span class="searchbox-count" data-count></span>
      </label>
      <button class="iconbtn" data-add aria-label="add link" title="add link (⌘N)" type="button">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      <button class="iconbtn" data-filter aria-label="toggle filter" title="filter (F)" type="button">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <span class="iconbtn-badge" data-filter-badge></span>
      </button>
      <button class="iconbtn" data-theme-toggle aria-label="toggle theme" title="toggle theme (T)" type="button">
        <!-- glyph painted at runtime: sun when in dark mode (action = go light),
             moon when in light mode (action = go dark). -->
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-theme-icon></svg>
      </button>
      <button class="iconbtn" data-view aria-label="toggle view" title="toggle view (V)" type="button">
        <!-- glyph swapped at runtime by setView() so it shows the OPPOSITE
             of the current mode (i.e. the action about to happen). -->
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-view-icon></svg>
      </button>
      <button class="iconbtn agent-mode-btn" data-agent-view aria-label="agent mode" title="agent mode" type="button">agent</button>
    </div>

    <section class="write-panel" data-write hidden>
      <div class="write-panel-head" aria-hidden="true">
        <span>link or long-form note</span>
        <span>paste a URL, then add your own note</span>
      </div>
      <div class="write-panel-body write-panel-body--stacked">
        <input type="url" data-write-url placeholder="paste a link…" aria-label="paste a link">
        <textarea placeholder="add context…" rows="1" aria-label="write a new link note"></textarea>
        <aside class="similar-notes" data-similar hidden>
          <div class="similar-notes-head">
            <span>similar notes</span>
            <button type="button" class="panel-link" data-similar-refresh>refresh</button>
          </div>
          <div class="similar-notes-list" data-similar-list></div>
        </aside>
      </div>
      <div class="write-panel-tagrow" data-write-tagrow></div>
      <div class="panel-foot">
        <span class="panel-hint"><kbd>esc</kbd> cancel</span>
        <span class="panel-stats" data-write-stats>0 words · 0 chars</span>
        <span class="panel-status" data-write-status></span>
        <button type="button" class="panel-link similar-toggle" data-similar-toggle aria-label="show similar links">similar links</button>
        <button type="button" class="panel-link" data-write-expand aria-label="expand write panel">expand</button>
        <button type="button" class="panel-save" data-write-save aria-label="save link">save</button>
      </div>
    </section>

    <section class="filter-panel" data-filter-panel hidden>
      <label class="suggestions-toggle" data-suggestions-toggle>
        <input type="checkbox" data-suggestions-checkbox>
        <span class="suggestions-toggle-label">show pending suggestions</span>
        <span class="suggestions-toggle-count" data-suggestions-count></span>
      </label>
      <div class="pills" data-pills></div>
    </section>
  `;

  // --- Search ---

  const searchInput = el.querySelector<HTMLInputElement>('.searchbox input')!;
  const countEl = el.querySelector<HTMLElement>('[data-count]')!;
  let searchTimer: number | null = null;
  searchInput.addEventListener('input', () => {
    if (searchTimer != null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => opts.onSearch(searchInput.value.trim()), 150);
  });

  function setCount(shown: number, total: number) {
    // Show count only when filtering (search query or active tags). Otherwise
    // an idle "5,231" sitting in the search bar is just noise.
    //
    // Two-color instrument readout (D-030): matched in teal, total in muted
    // taupe. The `.matched` class is styled in board.css.
    const filtering = searchInput.value.trim().length > 0 || active.size > 0;
    if (!filtering) {
      countEl.textContent = '';
      return;
    }
    countEl.innerHTML = `<span class="matched">${shown.toLocaleString()}</span> / ${total.toLocaleString()}`;
  }

  // --- Filter button (pills panel) ---
  // Filter stays inline (not extracted) because it shares `active` with Search's
  // setCount above, and `notes` with the suggestions toggle below.

  const filterBtn = el.querySelector<HTMLButtonElement>('[data-filter]')!;
  const filterPanel = el.querySelector<HTMLElement>('[data-filter-panel]')!;
  const pillsContainer = el.querySelector<HTMLElement>('[data-pills]')!;
  const filterBadge = el.querySelector<HTMLElement>('[data-filter-badge]')!;

  let notes: Note[] = [];
  const active = new Set<string>();

  function renderPills() {
    const counts = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    const ordered = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const parts: string[] = [];
    parts.push(
      `<button class="pill all ${active.size === 0 ? 'active' : ''}" data-tag="" type="button">all <span class="n">${notes.length.toLocaleString()}</span></button>`,
    );
    for (const [tag, count] of ordered) {
      const c = tagColor(tag);
      const cls = active.has(tag) ? 'pill active' : 'pill';
      parts.push(
        `<button class="${cls}" data-tag="${escapeAttr(tag)}" style="--c:${c}" type="button">${escapeHtml(tag)}<span class="n">${count}</span></button>`,
      );
    }
    if (active.size > 0) {
      parts.push(`<button class="pill clear" data-tag="__clear__" type="button">clear ✕</button>`);
    }
    pillsContainer.innerHTML = parts.join('');
    // Badge on the filter icon button
    if (active.size > 0) {
      filterBadge.textContent = String(active.size);
      filterBtn.classList.add('has-active');
    } else {
      filterBadge.textContent = '';
      filterBtn.classList.remove('has-active');
    }
  }

  pillsContainer.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.pill');
    if (!btn) return;
    const tag = btn.dataset.tag ?? '';
    if (tag === '' || tag === '__clear__') active.clear();
    else if (active.has(tag)) active.delete(tag);
    else active.add(tag);
    renderPills();
    opts.onFilterChange(new Set(active));
  });

  function openFilter()  { filterPanel.hidden = false; filterBtn.classList.add('active'); }
  function closeFilter() { filterPanel.hidden = true;  filterBtn.classList.remove('active'); }
  function toggleFilter(){ if (filterPanel.hidden) openFilter(); else closeFilter(); }
  filterBtn.addEventListener('click', toggleFilter);

  // --- Sub-factories ---
  // Constructed after shared state (notes, active) is initialized so that the
  // global keydown listener below can reference handles from each one.

  const writePanelCtl = createWritePanel(el, {
    onAddNote: opts.onAddNote,
    onUpdateNote: opts.onUpdateNote,
    getAllTags: opts.getAllTags,
    onFindSimilarNotes: opts.onFindSimilarNotes,
    onOpenNote: opts.onOpenNote,
  });
  const suggestionsToggle = createSuggestionsToggle(
    el,
    opts.initialShowSuggestions ?? true,
    opts.onShowSuggestionsChange,
  );
  const viewToggle = createViewToggle(el, opts.initialView, opts.onViewChange);
  const themeToggle = createThemeToggle(el);

  // --- Global keybindings ---

  document.addEventListener('keydown', (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    const activeEl = document.activeElement as HTMLElement | null;
    const inField =
      activeEl?.tagName === 'INPUT' ||
      activeEl?.tagName === 'TEXTAREA' ||
      activeEl?.isContentEditable;

    if (isMod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      writePanelCtl.open();
    } else if (isMod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key === '/' && !inField) {
      e.preventDefault();
      searchInput.focus();
    } else if (e.key === 'f' && !inField) {
      e.preventDefault();
      toggleFilter();
    } else if (e.key === 'v' && !inField) {
      e.preventDefault();
      viewToggle.trigger();
    } else if (e.key === 't' && !inField) {
      e.preventDefault();
      themeToggle.trigger();
    } else if (e.key === 'Escape') {
      // Cascade: close write → close filter → clear/blur search
      if (writePanelCtl.isOpen()) { writePanelCtl.close(); return; }
      if (!filterPanel.hidden) { closeFilter(); return; }
      if (activeEl === searchInput) {
        if (searchInput.value) {
          searchInput.value = '';
          opts.onSearch('');
        } else {
          searchInput.blur();
        }
      }
    }
  });

  return {
    el,
    setNotes(next) {
      notes = next;
      renderPills();
      suggestionsToggle.update(next);
    },
    setCount,
    getActive() { return new Set(active); },
    setView: viewToggle.setView,
    getShowSuggestions: suggestionsToggle.getShow,
  };
}

// --- Theme toggle (light ↔ dark) ---
// Persisted in localStorage under 'theme'. Initial value is resolved by the
// inline boot script in index.html (sets data-theme on <html> before paint
// to avoid a flash). Falls back to prefers-color-scheme.

type Theme = 'light' | 'dark';

// Sun glyph (shown in dark mode = action goes light) / moon glyph (light mode = action goes dark).
const THEME_GLYPH: Record<Theme, string> = {
  light:
    '<path d="M12 9.5A5.5 5.5 0 0 1 6.5 4a5 5 0 0 0 6.5 6.5 5.5 5.5 0 0 1-1 -1z" ' +
    'fill="currentColor" stroke="none"/>',
  dark:
    '<circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/>' +
    '<path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};

function createThemeToggle(el: HTMLElement): { trigger: () => void } {
  const themeBtn = el.querySelector<HTMLButtonElement>('[data-theme-toggle]')!;
  const themeIcon = themeBtn.querySelector<SVGElement>('[data-theme-icon]')!;

  function currentTheme(): Theme {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function paintThemeIcon() {
    const t = currentTheme();
    themeIcon.innerHTML = THEME_GLYPH[t];
    themeBtn.title = t === 'dark' ? 'switch to light (T)' : 'switch to dark (T)';
    themeBtn.setAttribute('aria-label', themeBtn.title);
  }
  paintThemeIcon();
  themeBtn.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* private mode */ }
    paintThemeIcon();
  });

  return { trigger: () => themeBtn.click() };
}

// --- View toggle (masonry ↔ list) ---
// D-031: runtime mode, not a route. D-036: icon shows the next action.

// Inline SVG paint. The glyph shows the NEXT view (what clicking does), not
// the current one. Cycle: masonry ↔ list. Agent has its own button.
//   current=masonry  → list glyph (3 lines w/ leading dots)
//   current=list     → grid glyph (4 squares)
//   current=agent    → grid glyph (4 squares)
const VIEW_GLYPH: Record<BoardView, string> = {
  masonry:
    '<circle cx="3" cy="4" r="1" fill="currentColor"/>' +
    '<circle cx="3" cy="8" r="1" fill="currentColor"/>' +
    '<circle cx="3" cy="12" r="1" fill="currentColor"/>' +
    '<path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  list:
    '<rect x="2.5" y="2.5" width="4" height="4" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
    '<rect x="9.5" y="2.5" width="4" height="4" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
    '<rect x="2.5" y="9.5" width="4" height="4" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
    '<rect x="9.5" y="9.5" width="4" height="4" stroke="currentColor" stroke-width="1.2" fill="none"/>',
  whiteboard:
    '<path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '<circle cx="11.8" cy="12.3" r="2.2" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
    '<path d="M13.5 14l1.2 1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  agent:
    '<rect x="2.5" y="2.5" width="4" height="4" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
    '<rect x="9.5" y="2.5" width="4" height="4" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
    '<rect x="2.5" y="9.5" width="4" height="4" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
    '<rect x="9.5" y="9.5" width="4" height="4" stroke="currentColor" stroke-width="1.2" fill="none"/>',
};

/** Visible cycle: masonry ↔ list. Whiteboard stays in code, and agent has
 *  a separate button instead of being part of the cycle. */
function nextView(current: BoardView): BoardView {
  return current === 'masonry' ? 'list' : 'masonry';
}

/** Human-readable title for the view-toggle button. */
function viewToggleTitle(current: BoardView): string {
  return current === 'masonry' ? 'switch to list (V)' : 'switch to grid (V)';
}

function createViewToggle(
  el: HTMLElement,
  initialView: BoardView,
  onChange: (view: BoardView) => void,
): { trigger: () => void; setView: (v: BoardView) => void } {
  const viewBtn = el.querySelector<HTMLButtonElement>('[data-view]')!;
  const viewIcon = viewBtn.querySelector<SVGElement>('[data-view-icon]')!;
  const agentBtn = el.querySelector<HTMLButtonElement>('[data-agent-view]')!;
  let currentView: BoardView = initialView;

  function paintViewIcon() {
    viewIcon.innerHTML = VIEW_GLYPH[currentView];
    viewBtn.title = viewToggleTitle(currentView);
    viewBtn.setAttribute('aria-label', viewBtn.title);
    agentBtn.classList.toggle('active', currentView === 'agent');
  }
  paintViewIcon();

  viewBtn.addEventListener('click', () => {
    currentView = nextView(currentView);
    paintViewIcon();
    onChange(currentView);
  });
  agentBtn.addEventListener('click', () => {
    if (currentView === 'agent') return;
    currentView = 'agent';
    paintViewIcon();
    onChange(currentView);
  });

  return {
    trigger: () => viewBtn.click(),
    setView(v) { currentView = v; paintViewIcon(); },
  };
}

// --- Pending-suggestions toggle ---
// Checkbox + count badge inside the filter panel. The count is the number of
// notes whose pendingSuggestion has at least one tag not already accepted.

function createSuggestionsToggle(
  el: HTMLElement,
  initialShowSuggestions: boolean,
  onChange: ((show: boolean) => void) | undefined,
): { update: (notes: Note[]) => void; getShow: () => boolean } {
  const sugCheckbox = el.querySelector<HTMLInputElement>('[data-suggestions-checkbox]')!;
  const sugCount = el.querySelector<HTMLElement>('[data-suggestions-count]')!;
  let showSuggestions = initialShowSuggestions;
  sugCheckbox.checked = showSuggestions;
  sugCheckbox.addEventListener('change', () => {
    showSuggestions = sugCheckbox.checked;
    onChange?.(showSuggestions);
  });

  function update(notes: Note[]) {
    let n = 0;
    for (const note of notes) {
      const ps = note.pendingSuggestion;
      if (!ps) continue;
      if (ps.tags.some(t => !note.tags.includes(t))) n++;
    }
    sugCount.textContent = n > 0 ? `(${n.toLocaleString()})` : '';
  }

  return { update, getShow: () => showSuggestions };
}

// --- Plus button (write panel) ---
// Owns the + button, the write panel section, the textarea autogrow, the
// chip strip, in-flight guard, and submit/cancel handlers. The panel
// preserves text + tags across open/close so users can dismiss and reopen
// without losing draft state.

const WRITE_AUTOSAVE_MS = 600;

type WritePanelOpts = {
  onAddNote: (input: { text: string; tags: string[]; sourceUrl?: string }) => Promise<NoteWriteResult> | NoteWriteResult;
  onUpdateNote: (uuid: string, patch: { text: string; tags: string[] }) => Promise<NoteWriteResult> | NoteWriteResult;
  getAllTags: () => string[];
  onFindSimilarNotes?: (text: string, tags: string[], limit?: number) => Promise<SimilarNote[]>;
  onOpenNote?: (uuid: string) => void;
};

function createWritePanel(
  el: HTMLElement,
  opts: WritePanelOpts,
): { open: () => void; close: () => void; isOpen: () => boolean } {
  const addBtn = el.querySelector<HTMLButtonElement>('[data-add]')!;
  const writePanel = el.querySelector<HTMLElement>('[data-write]')!;
  const writeUrl = writePanel.querySelector<HTMLInputElement>('[data-write-url]')!;
  const writeTA = writePanel.querySelector<HTMLTextAreaElement>('textarea')!;
  const writeStatus = writePanel.querySelector<HTMLElement>('[data-write-status]')!;
  const writeStats = writePanel.querySelector<HTMLElement>('[data-write-stats]')!;
  const writeTagRow = writePanel.querySelector<HTMLElement>('[data-write-tagrow]')!;
  const similarAside = writePanel.querySelector<HTMLElement>('[data-similar]')!;
  const similarList = writePanel.querySelector<HTMLElement>('[data-similar-list]')!;
  const similarToggle = writePanel.querySelector<HTMLButtonElement>('[data-similar-toggle]')!;
  const similarRefresh = writePanel.querySelector<HTMLButtonElement>('[data-similar-refresh]')!;
  const saveBtn = el.querySelector<HTMLButtonElement>('[data-write-save]')!;
  const expandBtn = el.querySelector<HTMLButtonElement>('[data-write-expand]')!;

  const growTextarea = () => {
    writeTA.style.height = 'auto';
    if (!writePanel.classList.contains('expanded')) writeTA.style.height = writeTA.scrollHeight + 'px';
  };
  const updateStats = () => {
    const text = writeTA.value.trim();
    const words = text ? text.split(/\s+/).length : 0;
    const urlState = writeUrl.value.trim() ? ' · link' : '';
    writeStats.textContent = `${words.toLocaleString()} words · ${writeTA.value.length.toLocaleString()} chars${urlState}`;
  };

  const flashStatus = (msg: string, ms = 900) => {
    writeStatus.textContent = msg;
    writeStatus.classList.add('show');
    window.setTimeout(() => {
      if (writeStatus.textContent === msg) writeStatus.classList.remove('show');
    }, ms);
  };

  // Write-panel chip strip owns its own tags. Expanded mode autosaves the
  // first POST uuid, then PATCHes that same note to avoid duplicate drafts.
  let writeTags: string[] = [];
  let savedUuid: string | null = null;
  let initialSourceUrl = '';
  let lastSavedText = '';
  let lastSavedTags: string[] = [];
  let writeInflight = false;
  let autosaveTimer: number | null = null;
  let saveAgain = false;
  let similarOpen = false;
  let similarLoading = false;
  let similarLoadedKey = '';

  function currentSimilarKey() {
    return JSON.stringify([writeUrl.value.trim(), writeTA.value.trim(), writeTags]);
  }

  function resetSimilar() {
    similarOpen = false;
    similarLoading = false;
    similarLoadedKey = '';
    similarAside.hidden = true;
    writePanel.classList.remove('similar-open');
    similarList.innerHTML = '';
    similarToggle.textContent = 'similar links';
  }

  function markSimilarDirty() {
    if (similarLoadedKey && currentSimilarKey() !== similarLoadedKey) similarToggle.textContent = 'refresh similar';
  }

  function renderSimilarNotes(notes: SimilarNote[]) {
    if (notes.length === 0) {
      similarList.innerHTML = '<p class="similar-notes-empty">no close matches</p>';
      return;
    }
    similarList.innerHTML = notes.map((note) => {
      const title = noteDisplayTitle(note);
      const excerpt = notePreviewText(note, 220);
      const tags = note.tags.slice(0, 4).map((tag) => `<span>#${escapeHtml(tag)}</span>`).join('');
      const source = noteSourceHost(note);
      return `<button type="button" class="similar-note-card" data-uuid="${escapeAttr(note.uuid)}">
        <span class="similar-note-text">${escapeHtml(title)}</span>
        <span class="similar-note-reason">${escapeHtml(note.reason)}${source ? ` · ${escapeHtml(source)}` : ''}</span>
        <span class="similar-note-text">${escapeHtml(excerpt)}</span>
        <span class="similar-note-tags">${tags}</span>
      </button>`;
    }).join('');
  }

  async function loadSimilarNotes() {
    const text = writeTA.value.trim();
    if (!text || similarLoading) return;
    if (!opts.onFindSimilarNotes) {
      similarList.innerHTML = '<p class="similar-notes-empty">similar links unavailable</p>';
      return;
    }
    similarOpen = true;
    similarAside.hidden = false;
    writePanel.classList.add('similar-open');
    similarLoading = true;
    similarToggle.textContent = 'hide similar';
    similarList.innerHTML = '<p class="similar-notes-empty">searching…</p>';
    const key = currentSimilarKey();
    try {
      const notes = await opts.onFindSimilarNotes(text, writeTags.slice(), 8);
      similarLoadedKey = key;
      renderSimilarNotes(notes);
    } catch (err) {
      console.error('[header] similar links failed', err);
      similarList.innerHTML = '<p class="similar-notes-empty">failed</p>';
    } finally {
      similarLoading = false;
      markSimilarDirty();
    }
  }

  const writeChips = createTagChips({
    getAllTags: opts.getAllTags,
    onTagsChange: (next) => {
      writeTags = next;
      markSimilarDirty();
      scheduleAutosave();
    },
  });
  writeTagRow.appendChild(writeChips.el);

  function sameTags(a: string[], b: string[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function clearAutosaveTimer() {
    if (autosaveTimer != null) {
      window.clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
  }

  function resetComposer() {
    writeUrl.disabled = false;
    writeUrl.value = '';
    writeTA.value = '';
    growTextarea();
    updateStats();
    writeTags = [];
    writeChips.setTags([]);
    savedUuid = null;
    initialSourceUrl = '';
    lastSavedText = '';
    lastSavedTags = [];
    resetSimilar();
  }

  function draftDirty() {
    const text = writeTA.value.trim();
    const sourceUrl = writeUrl.value.trim();
    if (!text && !sourceUrl) return false;
    return !savedUuid
      ? (text !== lastSavedText || !sameTags(writeTags, lastSavedTags) || sourceUrl !== initialSourceUrl)
      : (text !== lastSavedText || !sameTags(writeTags, lastSavedTags));
  }

  function scheduleAutosave() {
    if (!writePanel.classList.contains('expanded')) return;
    if (!writeTA.value.trim() && !writeUrl.value.trim()) return;
    clearAutosaveTimer();
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = null;
      void saveWrite(false);
    }, WRITE_AUTOSAVE_MS);
  }

  async function saveWrite(closeAfter: boolean) {
    const text = writeTA.value.trim();
    const sourceUrl = writeUrl.value.trim();
    if (!text && !sourceUrl) {
      flashStatus('empty', 1400);
      return false;
    }
    clearAutosaveTimer();
    if (writeInflight) {
      saveAgain = true;
      return false;
    }

    const tags = writeTags.slice();
    if (savedUuid && text === lastSavedText && sameTags(tags, lastSavedTags)) {
      flashStatus(isFallback() ? 'saved (local)' : 'saved');
      if (closeAfter) { resetComposer(); close(); }
      return true;
    }

    writeInflight = true;
    writeStatus.textContent = 'saving…';
    writeStatus.classList.add('show');
    try {
      const note = savedUuid
        ? await opts.onUpdateNote(savedUuid, { text: text || lastSavedText, tags })
        : await opts.onAddNote({ text, tags, sourceUrl: sourceUrl || undefined });
      if (!note) throw new Error('empty save result');
      savedUuid = note.uuid;
      initialSourceUrl = sourceUrl || note.sourceUrl || '';
      writeUrl.value = initialSourceUrl;
      writeUrl.disabled = Boolean(initialSourceUrl);
      lastSavedText = note.text;
      lastSavedTags = note.tags.slice();
      writeTags = note.tags.slice();
      writeChips.setTags(writeTags);
      flashStatus(isFallback() ? 'saved (local)' : 'saved');
      if (closeAfter) { resetComposer(); close(); }
      return true;
    } catch (err) {
      console.error('[header] write failed', err);
      flashStatus('failed', 1400);
      return false;
    } finally {
      writeInflight = false;
      if (saveAgain && writePanel.classList.contains('expanded')) scheduleAutosave();
      saveAgain = false;
    }
  }

  writeUrl.addEventListener('input', () => { updateStats(); markSimilarDirty(); scheduleAutosave(); });
  writeTA.addEventListener('input', () => { growTextarea(); updateStats(); markSimilarDirty(); scheduleAutosave(); });

  writeTA.addEventListener('keydown', (e) => {
    // ⌘/Ctrl+Enter shortcut intentionally removed — save is the explicit
    // button click so the UI behaves the same on desktop and mobile.
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  saveBtn.addEventListener('click', () => { void saveWrite(true); });
  similarToggle.addEventListener('click', () => {
    if (similarOpen && similarToggle.textContent !== 'refresh similar') {
      resetSimilar();
      return;
    }
    void loadSimilarNotes();
  });
  similarRefresh.addEventListener('click', () => { void loadSimilarNotes(); });
  similarList.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-uuid]');
    if (card?.dataset.uuid) opts.onOpenNote?.(card.dataset.uuid);
  });
  expandBtn.addEventListener('click', () => {
    const expanded = writePanel.classList.toggle('expanded');
    expandBtn.textContent = expanded ? 'compact' : 'expand';
    expandBtn.setAttribute('aria-label', expanded ? 'compact write panel' : 'expand write panel');
    if (expanded) scheduleAutosave(); else { clearAutosaveTimer(); resetSimilar(); }
    requestAnimationFrame(() => { writeTA.focus(); growTextarea(); });
  });

  function open() {
    writePanel.hidden = false;
    addBtn.classList.add('active');
    // Panel preserves text + tags across open/close; just paint chips from
    // the in-memory writeTags state.
    writeChips.setTags(writeTags);
    updateStats();
    requestAnimationFrame(() => {
      (writeUrl.value.trim() ? writeTA : writeUrl).focus();
      growTextarea();
    });
  }
  function close() {
    if (writePanel.classList.contains('expanded') && draftDirty()) void saveWrite(false);
    else clearAutosaveTimer();
    writePanel.hidden = true;
    writePanel.classList.remove('expanded');
    resetSimilar();
    expandBtn.textContent = 'expand';
    expandBtn.setAttribute('aria-label', 'expand write panel');
    addBtn.classList.remove('active');
  }
  function toggle() {
    if (writePanel.hidden) open(); else close();
  }
  addBtn.addEventListener('click', toggle);

  return { open, close, isOpen: () => !writePanel.hidden };
}

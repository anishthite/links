// Tag chip strip — reusable factory used in both the write panel (header.ts)
// and the note editor overlay (note-editor.ts).
//
// As of 2026-06-02 tags are a standalone field on the note (no longer derived
// from inline #hashtags in text). The chip strip now owns a tags array and
// emits onTagsChange when it mutates. Callers track the tags state separately
// from the textarea value and include it in the save payload.
//
// Keyboard for the add input:
//   Enter        commit (if valid normalized tag)
//   ArrowUp/Down move autocomplete selection
//   Tab          accept current autocomplete suggestion
//   Esc / blur   revert (close input)

import { tagColor } from './lib/colors';
import { normalizeTag } from './lib/tags';
import { escapeHtml, escapeAttr } from './lib/html-escape';

export type TagChipsOpts = {
  /** Called whenever the chip set mutates. Caller is the source of truth for
   *  saving — pass the array straight to the API. */
  onTagsChange: (next: string[]) => void;
  /** Live read of the existing-tag universe for autocomplete. */
  getAllTags: () => string[];
};

export type TagChipsHandle = {
  /** Root element to mount in the DOM. */
  el: HTMLElement;
  /** Replace the chip set without firing onTagsChange. Use on open / external sync. */
  setTags: (tags: string[]) => void;
  /** Read the current chip set. */
  getTags: () => string[];
  /** Programmatically open the add-input. */
  focusAddInput: () => void;
  /** Detach event listeners (rare; for cleanup). */
  destroy: () => void;
};

export function createTagChips(opts: TagChipsOpts): TagChipsHandle {
  const root = document.createElement('div');
  root.className = 'tag-chips';
  root.innerHTML = `<div class="tag-chips-row" data-row></div>`;
  const row = root.querySelector<HTMLElement>('[data-row]')!;

  let currentTags: string[] = [];

  // --- Add-input lifecycle state ---
  let addInputWrap: HTMLElement | null = null;
  let addInput: HTMLInputElement | null = null;
  let addMenu: HTMLElement | null = null;
  let addSelectedIdx = -1;
  let addFiltered: string[] = [];

  function render(): void {
    const parts: string[] = [];
    for (const tag of currentTags) {
      const c = tagColor(tag);
      parts.push(
        `<span class="tag-chip" style="--c:${c}" data-tag="${escapeAttr(tag)}">` +
          `<span class="tag-chip-label">${escapeHtml(tag)}</span>` +
          `<button type="button" class="tag-chip-remove" aria-label="remove ${escapeAttr(tag)}" data-remove="${escapeAttr(tag)}">×</button>` +
        `</span>`,
      );
    }
    parts.push(`<button type="button" class="tag-chip-add" data-add>+ tag</button>`);
    row.innerHTML = parts.join('');
  }

  function commitMutation(next: string[]): void {
    // Reference equality check via JSON serialization (cheap at N ≤ 32).
    if (JSON.stringify(next) === JSON.stringify(currentTags)) return;
    currentTags = next;
    opts.onTagsChange(next.slice());
    render();
  }

  function handleRemove(tag: string): void {
    if (!currentTags.includes(tag)) return;
    commitMutation(currentTags.filter(t => t !== tag));
  }

  function handleAddCommit(raw: string): boolean {
    const tag = normalizeTag(raw);
    if (!tag) return false;
    if (currentTags.includes(tag)) return true;   // already present, treat as no-op success
    commitMutation([...currentTags, tag]);
    return true;
  }

  // ---- Add-input ----

  function openAdd(): void {
    if (addInputWrap) { addInput?.focus(); return; }
    const addBtn = row.querySelector<HTMLButtonElement>('[data-add]');
    if (!addBtn) return;

    addInputWrap = document.createElement('span');
    addInputWrap.className = 'tag-chip-input-wrap';
    addInputWrap.innerHTML = `
      <input type="text" class="tag-chip-input" placeholder="tag…" autocomplete="off"
             autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="add tag">
      <div class="tag-chip-menu" data-menu hidden role="listbox" aria-label="tag suggestions"></div>
    `;
    addBtn.replaceWith(addInputWrap);
    addInput = addInputWrap.querySelector<HTMLInputElement>('input')!;
    addMenu = addInputWrap.querySelector<HTMLElement>('[data-menu]')!;
    addSelectedIdx = -1;

    refreshMenu('');

    addInput.addEventListener('input', () => refreshMenu(addInput!.value));
    addInput.addEventListener('keydown', onAddKey);
    addInput.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (!addInputWrap) return;
        if (document.activeElement === addInput) return;
        closeAdd(false);
      }, 120);
    });

    addInput.focus();
  }

  function closeAdd(commit: boolean): void {
    if (!addInputWrap) return;
    const raw = addInput?.value ?? '';
    const wrap = addInputWrap;
    addInputWrap = null;
    addInput = null;
    addMenu = null;
    addSelectedIdx = -1;
    addFiltered = [];

    if (commit && raw.trim()) {
      const ok = handleAddCommit(raw);
      if (!ok) { render(); return; }
      render();
      return;
    }
    wrap.replaceWith(makeAddButton());
  }

  function makeAddButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-chip-add';
    btn.dataset.add = '';
    btn.textContent = '+ tag';
    return btn;
  }

  function onAddKey(e: KeyboardEvent): void {
    if (!addInput || !addMenu) return;
    switch (e.key) {
      case 'Enter': {
        e.preventDefault();
        if (addSelectedIdx >= 0 && addFiltered[addSelectedIdx]) {
          addInput.value = addFiltered[addSelectedIdx]!;
        }
        closeAdd(true);
        return;
      }
      case 'Escape': {
        e.preventDefault();
        e.stopPropagation();
        closeAdd(false);
        return;
      }
      case 'Tab': {
        if (addSelectedIdx >= 0 && addFiltered[addSelectedIdx]) {
          e.preventDefault();
          addInput.value = addFiltered[addSelectedIdx]!;
          refreshMenu(addInput.value);
        }
        return;
      }
      case 'ArrowDown': {
        e.preventDefault();
        if (addFiltered.length === 0) return;
        addSelectedIdx = (addSelectedIdx + 1) % addFiltered.length;
        paintMenuSelection();
        return;
      }
      case 'ArrowUp': {
        e.preventDefault();
        if (addFiltered.length === 0) return;
        addSelectedIdx = (addSelectedIdx - 1 + addFiltered.length) % addFiltered.length;
        paintMenuSelection();
        return;
      }
      default:
        return;
    }
  }

  function refreshMenu(query: string): void {
    if (!addMenu) return;
    const q = query.trim().toLocaleLowerCase().replace(/^#/, '');
    const universe = opts.getAllTags();
    const existing = new Set(currentTags);
    const pool = universe.filter(t => !existing.has(t));

    let ranked: string[];
    if (q.length === 0) {
      ranked = pool.slice().sort().slice(0, 8);
    } else {
      const prefix = pool.filter(t => t.startsWith(q)).sort();
      const substr = pool.filter(t => !t.startsWith(q) && t.includes(q)).sort();
      ranked = [...prefix, ...substr].slice(0, 8);
    }
    addFiltered = ranked;
    addSelectedIdx = ranked.length > 0 ? 0 : -1;

    if (ranked.length === 0) {
      addMenu.hidden = true;
      addMenu.innerHTML = '';
      return;
    }
    addMenu.hidden = false;
    addMenu.innerHTML = ranked.map((t, i) => {
      const c = tagColor(t);
      return `<button type="button" class="tag-chip-menu-item" data-pick="${escapeAttr(t)}" data-idx="${i}" style="--c:${c}" role="option">${escapeHtml(t)}</button>`;
    }).join('');
    paintMenuSelection();
  }

  function paintMenuSelection(): void {
    if (!addMenu) return;
    addMenu.querySelectorAll<HTMLElement>('.tag-chip-menu-item').forEach((el, i) => {
      el.classList.toggle('selected', i === addSelectedIdx);
    });
  }

  function onRowClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const removeBtn = target.closest<HTMLElement>('[data-remove]');
    if (removeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const tag = removeBtn.dataset.remove;
      if (tag) handleRemove(tag);
      return;
    }
    const addBtn = target.closest<HTMLElement>('[data-add]');
    if (addBtn) {
      e.preventDefault();
      e.stopPropagation();
      openAdd();
      return;
    }
    const pickBtn = target.closest<HTMLElement>('[data-pick]');
    if (pickBtn && addInput) {
      e.preventDefault();
      e.stopPropagation();
      addInput.value = pickBtn.dataset.pick ?? '';
      closeAdd(true);
      return;
    }
  }

  function onRowMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('[data-pick]')) e.preventDefault();
  }

  row.addEventListener('click', onRowClick);
  row.addEventListener('mousedown', onRowMouseDown);

  render();

  return {
    el: root,
    setTags(tags) {
      currentTags = tags.slice();
      if (addInputWrap) {
        // Re-render chips around the open add-input.
        render();
        const addBtn = row.querySelector<HTMLButtonElement>('[data-add]');
        if (addBtn) addBtn.replaceWith(addInputWrap);
      } else {
        render();
      }
    },
    getTags() { return currentTags.slice(); },
    focusAddInput() { openAdd(); },
    destroy() {
      row.removeEventListener('click', onRowClick);
      row.removeEventListener('mousedown', onRowMouseDown);
      root.remove();
    },
  };
}

// Note editor — full-page overlay that opens when a note tile is clicked.
//
// Single-instance: createNoteEditor() mounts one backdrop + panel pair into
// document.body. open(note) populates the textarea, focuses, places caret at
// end. close() hides it. The same DOM is reused for every note (cheap).
//
// Keyboard / interaction contract:
//   (input)        →  debounced auto-save (AUTOSAVE_MS after last keystroke)
//   esc            →  close (flushes any pending save before closing)
//   click backdrop →  close (flushes any pending save before closing)
//   delete button  →  click once → confirm prompt; click again → delete
//
// Save is async via opts.onSave. If onSave throws or returns null we surface
// "failed" briefly and keep the editor open. Delete is async via opts.onDelete.

import type { Note } from './lib/types';
import { fmtDate } from './lib/format';
import { noteSourceHost } from './lib/link-note';
import { createTagChips } from './tag-chips';

/** How long after the user stops typing before we auto-save. */
const AUTOSAVE_MS = 600;

export type NoteEditorOpts = {
  /** Persist the edit. Either or both of `text` / `tags` may differ from the
   *  last saved state; the implementation forwards exactly the fields that
   *  changed so the server can keep `updated_at` vs `tags_updated_at`
   *  bookkeeping straight (see implementation-notes/2026-06-02-tags-standalone.html#D-010).
   *  Returns the updated note (server truth) or null on failure. */
  onSave: (uuid: string, patch: { text?: string; tags?: string[] }) => Promise<Note | null>;
  /** Permanently delete the note. Resolve true on success, false on failure. */
  onDelete: (uuid: string) => Promise<boolean>;
  /** Jump into agent chat using the current note draft as the starting point. */
  onStartChat?: (note: Note) => void;
  /** Refetch source metadata/text for link-backed notes. */
  onRefreshLink?: (uuid: string) => Promise<Note | null>;
  /** Live read of all known tags for the chip-strip autocomplete. */
  getAllTags: () => string[];
};

export function createNoteEditor(opts: NoteEditorOpts): {
  /** Mount the overlay DOM. Idempotent. Call once during app boot. */
  mount: (root: HTMLElement) => void;
  /** Open the editor pre-populated with the given note. */
  open: (note: Note) => void;
  /** Close the editor. Flushes any pending auto-save first. Safe to call when already closed. */
  close: () => void;
  /** True if the editor is currently visible. */
  isOpen: () => boolean;
} {
  const backdrop = document.createElement('div');
  backdrop.className = 'note-editor-backdrop';
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <section class="note-editor" role="dialog" aria-modal="true" aria-label="edit note">
      <textarea class="note-editor-text" aria-label="edit note text" rows="1"></textarea>
      <div class="note-editor-tagrow" data-tagrow></div>
      <div class="note-editor-foot">
        <button type="button" class="note-editor-delete" data-delete aria-label="delete note">delete</button>
        <button type="button" class="panel-link" data-open-source aria-label="open source link" hidden>open source</button>
        <button type="button" class="panel-link" data-refresh-link aria-label="refresh source metadata" hidden>refresh link</button>
        <button type="button" class="panel-link" data-chat aria-label="start chat from note">chat with this</button>
        <span class="note-editor-meta" data-meta></span>
        <span class="note-editor-hint"><kbd>esc</kbd> close</span>
        <span class="note-editor-status" data-status></span>
      </div>
    </section>
  `;

  const panel    = backdrop.querySelector<HTMLElement>('.note-editor')!;
  const textarea = backdrop.querySelector<HTMLTextAreaElement>('.note-editor-text')!;
  const metaEl   = backdrop.querySelector<HTMLElement>('[data-meta]')!;
  const statusEl = backdrop.querySelector<HTMLElement>('[data-status]')!;
  const deleteBtn = backdrop.querySelector<HTMLButtonElement>('[data-delete]')!;
  const openSourceBtn = backdrop.querySelector<HTMLButtonElement>('[data-open-source]')!;
  const refreshLinkBtn = backdrop.querySelector<HTMLButtonElement>('[data-refresh-link]')!;
  const chatBtn = backdrop.querySelector<HTMLButtonElement>('[data-chat]')!;
  const tagRow   = backdrop.querySelector<HTMLElement>('[data-tagrow]')!;

  // Chip strip: chip mutations write to textarea + dispatch `input`, so the
  // existing autogrow + debounced autosave fires unchanged. We sync chips
  // back from text on every input so manual #hashtag edits stay in sync.
  // Chip strip: owns its own tags array, emits onTagsChange when mutated.
  // We track currentTags here separately from the textarea so the save payload
  // can diff text and tags independently (text-only edits keep board order;
  // tag-only edits don't reshuffle).
  const chips = createTagChips({
    getAllTags: opts.getAllTags,
    onTagsChange: (next) => {
      currentTags = next;
      scheduleSave();
    },
  });
  tagRow.appendChild(chips.el);

  let currentNote: Note | null = null;
  // Last text + tags we successfully sent to the server. Used to skip no-op
  // saves and to compute the minimal patch to PATCH.
  let lastSavedText = '';
  let lastSavedTags: string[] = [];
  let currentTags: string[] = [];
  let inflight = false;
  // setTimeout handle for the autosave debounce. Cleared on every input,
  // close(), and on the inflight save itself.
  let saveTimer: number | null = null;
  // Element to restore focus to on close. Set on open().
  let prevFocus: HTMLElement | null = null;
  // 2-click delete confirm state. Reset on close + on any non-delete interaction.
  let deletePrimed = false;
  let deletePrimedTimer: number | null = null;

  function grow() {
    textarea.style.height = 'auto';
    // Cap height at 70vh so very long notes still scroll inside the textarea
    // rather than blowing past the panel bounds.
    const max = Math.floor(window.innerHeight * 0.70);
    textarea.style.height = Math.min(textarea.scrollHeight, max) + 'px';
  }

  function setStatus(msg: string, tone: 'idle' | 'ok' | 'err' = 'ok') {
    statusEl.textContent = msg;
    statusEl.dataset.tone = tone;
    if (msg) statusEl.classList.add('show');
    else     statusEl.classList.remove('show');
  }

  function flashStatus(msg: string, tone: 'ok' | 'err' = 'ok', ms = 1100) {
    setStatus(msg, tone);
    window.setTimeout(() => {
      // Only clear if the message is still ours (avoid clobbering a newer message).
      if (statusEl.textContent === msg) setStatus('');
    }, ms);
  }

  /** Issue a save request now. Skips when text is unchanged, empty, or there's
   *  already an in-flight save (the next input event will reschedule). */
  async function saveNow() {
    if (!currentNote) return;
    if (saveTimer != null) { window.clearTimeout(saveTimer); saveTimer = null; }
    if (inflight) return;
    const text = textarea.value.trim();
    if (text.length === 0) {
      // Don't save an empty note (server would 400 anyway). Surface a hint;
      // the user can either type more or delete the note explicitly.
      setStatus('empty', 'err');
      return;
    }
    const textChanged = text !== lastSavedText;
    const tagsChanged = !sameStrings(currentTags, lastSavedTags);
    if (!textChanged && !tagsChanged) return;   // no-op
    inflight = true;
    setStatus('saving\u2026', 'ok');
    try {
      const patch: { text?: string; tags?: string[] } = {};
      if (textChanged) patch.text = text;
      if (tagsChanged) patch.tags = currentTags.slice();
      const updated = await opts.onSave(currentNote.uuid, patch);
      if (!updated) {
        setStatus('failed', 'err');
        return;
      }
      lastSavedText = updated.text;
      lastSavedTags = updated.tags.slice();
      currentTags = updated.tags.slice();
      currentNote = updated;
      metaEl.textContent = fmtDate(updated.updatedAt);
      // Server may have normalized tags (lowercased, dropped invalid). Sync
      // chips from server-canonical state so the UI doesn't drift.
      chips.setTags(updated.tags);
      flashStatus('saved', 'ok');
    } catch (err) {
      console.error('[note-editor] save failed', err);
      setStatus('failed', 'err');
    } finally {
      inflight = false;
      // If the user kept typing while the save was in flight, the input
      // listener will have re-armed the debounce timer; nothing else to do.
    }
  }

  function scheduleSave() {
    if (saveTimer != null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void saveNow();
    }, AUTOSAVE_MS);
  }

  function resetDeletePrime() {
    deletePrimed = false;
    deleteBtn.classList.remove('primed');
    deleteBtn.textContent = 'delete';
    if (deletePrimedTimer != null) {
      window.clearTimeout(deletePrimedTimer);
      deletePrimedTimer = null;
    }
  }

  async function handleDeleteClick() {
    if (!currentNote || inflight) return;
    if (!deletePrimed) {
      // First click: arm. Second click within 3s confirms.
      deletePrimed = true;
      deleteBtn.classList.add('primed');
      deleteBtn.textContent = 'click again to delete';
      deletePrimedTimer = window.setTimeout(resetDeletePrime, 3000);
      return;
    }
    // Confirmed. Cancel any pending autosave (we're deleting, not saving).
    if (saveTimer != null) { window.clearTimeout(saveTimer); saveTimer = null; }
    const uuid = currentNote.uuid;
    inflight = true;
    setStatus('deleting\u2026', 'err');
    try {
      const ok = await opts.onDelete(uuid);
      if (!ok) {
        setStatus('delete failed', 'err');
        resetDeletePrime();
        return;
      }
      // Hard close (skip flush — the note no longer exists).
      hardClose();
    } catch (err) {
      console.error('[note-editor] delete failed', err);
      setStatus('delete failed', 'err');
      resetDeletePrime();
    } finally {
      inflight = false;
    }
  }

  function snapshotCurrentNote(): Note | null {
    if (!currentNote) return null;
    const text = textarea.value.trim() || currentNote.text;
    return { ...currentNote, text, tags: currentTags.slice() };
  }

  function applyLoadedNote(note: Note) {
    currentNote = note;
    lastSavedText = note.text;
    lastSavedTags = note.tags.slice();
    currentTags = note.tags.slice();
    textarea.value = note.text;
    chips.setTags(note.tags);
    const sourceMeta = note.sourceUrl ? ` · ${noteSourceHost(note)}` : '';
    metaEl.textContent = `${fmtDate(note.updatedAt)}${sourceMeta}`;
    openSourceBtn.hidden = !note.sourceUrl;
    refreshLinkBtn.hidden = !note.sourceUrl;
  }

  async function handleRefreshLink() {
    if (!currentNote?.sourceUrl || !opts.onRefreshLink || inflight) return;
    setStatus('refreshing…', 'ok');
    try {
      const updated = await opts.onRefreshLink(currentNote.uuid);
      if (!updated) {
        setStatus('refresh failed', 'err');
        return;
      }
      applyLoadedNote(updated);
      grow();
      flashStatus('refreshed', 'ok');
    } catch (err) {
      console.error('[note-editor] refresh failed', err);
      setStatus('refresh failed', 'err');
    }
  }

  function startChatFromNote() {
    const note = snapshotCurrentNote();
    if (!note) return;
    close();
    opts.onStartChat?.(note);
  }

  /** Close without flushing. Used after a successful delete (no note to save to). */
  function hardClose() {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    currentNote = null;
    lastSavedText = '';
    lastSavedTags = [];
    currentTags = [];
    if (saveTimer != null) { window.clearTimeout(saveTimer); saveTimer = null; }
    setStatus('');
    resetDeletePrime();
    if (prevFocus && document.contains(prevFocus)) {
      prevFocus.focus({ preventScroll: true });
    }
    prevFocus = null;
    document.documentElement.style.overflow = '';
  }

  /** Close the editor, but first flush any pending autosave so the latest
   *  edits aren't dropped on the floor. We fire-and-forget the save (the
   *  board state still has the old text, but the next reload will reconcile). */
  function close() {
    if (backdrop.hidden) return;
    // If there's a pending debounced save OR unsaved text/tags, flush it.
    const dirty =
      currentNote != null &&
      (textarea.value.trim() !== lastSavedText ||
       !sameStrings(currentTags, lastSavedTags));
    if (saveTimer != null || dirty) {
      // Cancel timer, fire the save in background. We intentionally don't
      // await it \u2014 the user wants the panel to close immediately.
      if (saveTimer != null) { window.clearTimeout(saveTimer); saveTimer = null; }
      void saveNow();
    }
    hardClose();
  }

  function open(note: Note) {
    applyLoadedNote(note);
    setStatus('');
    resetDeletePrime();
    prevFocus = document.activeElement as HTMLElement | null;
    backdrop.hidden = false;
    // Lock background scroll while modal is up (the masonry's scroll listener
    // would otherwise keep firing and re-laying-out behind the dim).
    document.documentElement.style.overflow = 'hidden';
    // Defer focus + measure to next frame so the layout settles before we
    // try to grow the textarea.
    requestAnimationFrame(() => {
      grow();
      textarea.focus();
      // Place caret at end (default selection puts it at start).
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
  }

  textarea.addEventListener('input', () => {
    grow();
    // Any input invalidates a primed delete \u2014 they're back to editing.
    if (deletePrimed) resetDeletePrime();
    scheduleSave();
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void handleDeleteClick();
  });
  openSourceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentNote?.sourceUrl) window.open(currentNote.sourceUrl, '_blank', 'noopener,noreferrer');
  });
  refreshLinkBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void handleRefreshLink();
  });
  chatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startChatFromNote();
  });

  // Clicks on the backdrop (but NOT on the panel) close the editor.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  // Defensive: stop click bubbling out of the panel (in case the editor is
  // ever nested inside something with its own click handlers). Also resets
  // a primed delete if the user clicked elsewhere in the panel.
  panel.addEventListener('click', (e) => {
    e.stopPropagation();
    if (deletePrimed && !(e.target as HTMLElement).closest('[data-delete]')) {
      resetDeletePrime();
    }
  });

  return {
    mount(root) {
      if (backdrop.parentElement) return;
      root.appendChild(backdrop);
    },
    open,
    close,
    isOpen() { return !backdrop.hidden; },
  };
}

function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Note element factory. One .note div per visible note. The masonry layout
// positions/sizes it absolutely; this just paints the contents.
//
// Background = pastel of primary tag (D-022). Caption = mono date · tag · tag.
// Matched tags (under active filter) get underlined.
//
// Ghost pills (Phase-C, this file): when `note.pendingSuggestion` is set AND
// `opts.showSuggestions` is true, render the pending tags inline at the end of
// the caption as small dashed (medium) / dotted (low) pill chips. Click =
// accept that tag. Click × = reject that tag. Hover the group = rationale
// tooltip. The medium/low border-style + opacity convey confidence at a glance.

import type { Note } from './lib/types';
import { noteBgFor, tagColor } from './lib/colors';
import { fmtDate } from './lib/format';
import { noteDisplayTitle, noteSourceHost } from './lib/link-note';

export type StickyNoteOpts = {
  /** When false, ghost pills are skipped entirely (accepted tags still render). */
  showSuggestions?: boolean;
  /** User clicked a ghost pill to accept that specific tag. */
  onAccept?: (uuid: string, tag: string) => void;
  /** User clicked the × on a ghost pill to reject that specific tag. */
  onReject?: (uuid: string, tag: string) => void;
};

export function createStickyNote(
  note: Note,
  activeTags: Set<string>,
  opts: StickyNoteOpts = {},
): HTMLElement {
  const el = document.createElement('article');
  el.className = 'note';
  el.style.setProperty('--note-bg', noteBgFor(note.tags));
  el.dataset.uuid = note.uuid;

  // Body: cards stay collapsed; clicking the note opens the editor with full text.
  const text = document.createElement('p');
  text.className = 'text';
  text.textContent = noteDisplayTitle(note);
  el.appendChild(text);

  // Caption: date · tag · tag · ...  [· ghost · ghost · ...]
  const caption = document.createElement('div');
  caption.className = 'caption';

  const dateSpan = document.createElement('span');
  dateSpan.textContent = fmtDate(note.updatedAt);
  caption.appendChild(dateSpan);

  // Accepted (existing) tags as mono text — current behavior, untouched.
  if (note.tags.length > 0) {
    const sep = document.createElement('span');
    sep.className = 'dot';
    sep.textContent = '·';
    caption.appendChild(sep);

    note.tags.forEach((tag, i) => {
      if (i > 0) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.textContent = '·';
        caption.appendChild(dot);
      }
      const t = document.createElement('span');
      t.className = activeTags.has(tag) ? 'tag-mini matched' : 'tag-mini';
      t.style.setProperty('--c-fg', tagColor(tag));
      t.textContent = tag;
      caption.appendChild(t);
    });
  }

  // Ghost pills — pending suggestion tags. Filter out any that are already
  // accepted (we don't double-render).
  if (opts.showSuggestions && note.pendingSuggestion) {
    const pending = note.pendingSuggestion.tags.filter(t => !note.tags.includes(t));
    if (pending.length > 0) {
      const group = document.createElement('span');
      group.className = 'ghost-group';
      // Tooltip = rationale at the group level. Falls back silently if empty.
      if (note.pendingSuggestion.rationale) {
        group.title = note.pendingSuggestion.rationale;
      }
      // Visual separator between accepted tags and ghost pills (only if there
      // ARE accepted tags; otherwise the date dot already separates).
      if (note.tags.length > 0) {
        const sep = document.createElement('span');
        sep.className = 'dot ghost-sep';
        sep.textContent = '·';
        group.appendChild(sep);
      } else {
        const sep = document.createElement('span');
        sep.className = 'dot';
        sep.textContent = '·';
        group.appendChild(sep);
      }

      const confClass = note.pendingSuggestion.confidence === 'low' ? 'conf-low' : 'conf-medium';

      for (const tag of pending) {
        const pill = document.createElement('span');
        pill.className = `tag-ghost ${confClass}`;
        pill.style.setProperty('--c-fg', tagColor(tag));
        pill.dataset.tag = tag;

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'tag-ghost-label';
        label.textContent = tag;
        label.title = `accept "${tag}"`;
        label.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          // Visual feedback: solidify the pill briefly before the board
          // re-renders the whole note. The 180ms gives the user a sense of
          // "click registered" even though the actual DOM swap is instant.
          pill.classList.add('solidifying');
          opts.onAccept?.(note.uuid, tag);
        });
        pill.appendChild(label);

        const reject = document.createElement('button');
        reject.type = 'button';
        reject.className = 'tag-ghost-reject';
        reject.textContent = '×';
        reject.title = `reject "${tag}"`;
        reject.setAttribute('aria-label', `reject ${tag}`);
        reject.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          pill.classList.add('rejecting');
          opts.onReject?.(note.uuid, tag);
        });
        pill.appendChild(reject);

        group.appendChild(pill);
      }
      caption.appendChild(group);
    }
  }

  if (note.sourceUrl) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.textContent = '·';
    caption.appendChild(dot);

    const source = document.createElement('a');
    source.className = 'tag-mini';
    source.href = note.sourceUrl;
    source.target = '_blank';
    source.rel = 'noreferrer noopener';
    source.textContent = noteSourceHost(note) || 'link';
    source.addEventListener('click', (ev) => ev.stopPropagation());
    caption.appendChild(source);
  }

  el.appendChild(caption);

  return el;
}

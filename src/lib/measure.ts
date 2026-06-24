// The ONLY place @chenglou/pretext is imported (D-006). Everything else
// goes through `prepareNote()` and `measureNoteHeight()`. If pretext's API
// changes (it's pre-1.0), this is the single point of update.
//
// Pretext runs sync on the main thread (vite-pretext worker plugin requires
// Vite 8 which doesn't exist yet — see vite.config.ts). At v0 corpus size
// (~1.8k notes) prepare cost is sub-100ms, so this is fine.

import { prepare, layout, type PreparedText } from '@chenglou/pretext';
import type { Note, PreparedNote } from './types';
import { noteDisplayTitle } from './link-note';

// --- Design constants (must agree with src/styles/board.css `.note` rules) ---

/** Pretext requires a literal font string. system-ui is inaccurate per the docs;
 *  Inter must be loaded (document.fonts.ready) before prepare() runs.
 *  MUST mirror the rendered `.note .text` font in board.css — if these drift,
 *  pretext predicts widths under one face while the browser wraps under another
 *  and the extra/missing lines fall outside the card box. */
export const NOTE_TEXT_FONT  = '17px "Inter", system-ui, sans-serif';
export const NOTE_TEXT_SIZE  = 17;
export const NOTE_LINE_HEIGHT = Math.round(NOTE_TEXT_SIZE * 1.5);  // 26
export const NOTE_PADDING_X  = 20;
export const NOTE_PADDING_Y_TOP    = 18;
export const NOTE_PADDING_Y_BOTTOM = 16;
/** Reserved vertical space for the caption row in the height calc. Must match
 *  the rendered geometry of `.note .caption` exactly: margin-top + line-box.
 *  Pinned in board.css: margin-top:12 + line-height:16 + 4px bottom slack = 32.
 *  Bug 2026-05-28: was 30, but inherited body line-height (1.55) made the actual
 *  line box ~17px, so the bottom of digit descenders (5, 6, 7, 9) got shaved
 *  off the card. Fix: pin line-height to 16 in CSS AND bump reservation here. */
export const NOTE_CAPTION_HEIGHT = 32;

// --- Masonry geometry ---

export const GAP            = 22;   // between notes horizontally + vertically
export const MAX_COL_WIDTH  = 360;
export const SINGLE_COL_BREAK = 640;
export const MAX_GRID_NOTE_HEIGHT = 320;

export function capGridNoteHeight(height: number): number {
  return Math.min(height, MAX_GRID_NOTE_HEIGHT);
}

export function colCountForWidth(viewportWidth: number): number {
  if (viewportWidth <= SINGLE_COL_BREAK) return 1;
  // ~280px minimum column width; allow up to 5 columns on wide screens.
  const minCol = 260;
  return Math.max(2, Math.min(5, Math.floor((viewportWidth + GAP) / (minCol + GAP))));
}

// --- Pretext wrappers ---
//
// Pretext (as of the version we depend on) treats its input as one flowing paragraph
// and ignores `\n` characters. CSS `white-space: pre-wrap` does honour them. To keep
// the predicted height in sync with what the browser actually renders, we split the
// rendered card title on `\n` and prepare each non-empty line separately. Blank lines
// become `null` entries and contribute exactly one `NOTE_LINE_HEIGHT` to the total at
// layout time. See D-027.

export function prepareNote(note: Note): PreparedNote {
  const lines = noteDisplayTitle(note).split('\n');
  const prepared = lines.map(line =>
    line.length > 0 ? prepare(line, NOTE_TEXT_FONT) : null,
  );
  return { ...note, prepared };
}

/** Layout a prepared note and return its full sticky-note height in px. */
export function measureNoteHeight(
  prepared: (PreparedText | null)[],
  textWidth: number,
): number {
  let textHeight = 0;
  for (const line of prepared) {
    if (line === null) {
      textHeight += NOTE_LINE_HEIGHT;
    } else {
      textHeight += layout(line, textWidth, NOTE_LINE_HEIGHT).height;
    }
  }
  return (
    NOTE_PADDING_Y_TOP +
    textHeight +
    NOTE_CAPTION_HEIGHT +
    NOTE_PADDING_Y_BOTTOM
  );
}

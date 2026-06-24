// Date formatting for caption rows. Canonical format: `M/D/YYYY` (American numeric).
// Switched from `DD.MM.YY` 2026-05-28 — see implementation-notes.
// Note: no zero-padding on month or day ("5/3/2024", not "05/03/2024") to keep
// the caption row narrow enough that single-tag captions don't wrap.

export function fmtDate(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}


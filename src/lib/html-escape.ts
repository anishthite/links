// HTML-entity escaping for interpolating untrusted text into innerHTML/attributes.
// Shared by header.ts and tag-chips.ts (previously triplicated; pills.ts was
// the third copy until 2026-06-03).

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
}
export function escapeAttr(s: string): string { return escapeHtml(s); }

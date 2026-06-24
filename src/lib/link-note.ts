import type { Note } from './types';

type LinkNoteLike = {
  text: string;
  tags?: string[] | string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourceDescription?: string | null;
  sourceSiteName?: string | null;
  sourceContentText?: string | null;
  sourceLastError?: string | null;
};

export function noteHasSource(note: LinkNoteLike): boolean {
  return !!note.sourceUrl;
}

export function noteSearchText(note: LinkNoteLike): string {
  const tags = Array.isArray(note.tags)
    ? note.tags
    : typeof note.tags === 'string'
      ? safeTags(note.tags)
      : [];
  return [
    note.text,
    note.sourceTitle,
    note.sourceDescription,
    note.sourceSiteName,
    note.sourceUrl,
    note.sourceContentText,
    tags.map((tag) => `#${tag}`).join(' '),
  ].filter(Boolean).join('\n');
}

export function noteSourceHost(note: LinkNoteLike): string {
  const site = (note.sourceSiteName || '').trim();
  if (site) return site;
  const raw = (note.sourceUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

export function noteSummaryText(note: LinkNoteLike): string {
  const sourceTitle = compact(note.sourceTitle || '');
  const body = compact(note.text || '');
  if (body && sourceTitle && body.toLowerCase().startsWith(sourceTitle.toLowerCase())) return body;
  if (body) return body;
  return compact(note.sourceDescription || '') || sourceTitle || compact(note.sourceUrl || '');
}

export function notePreviewText(note: LinkNoteLike, max = 220): string {
  const text = compact(noteSummaryText(note) || note.sourceDescription || note.sourceContentText || note.sourceLastError || '');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function noteDisplayTitle(note: LinkNoteLike): string {
  return compact(note.sourceTitle || '') || firstNonBlankLine(note.text) || noteSourceHost(note) || 'Untitled';
}

export function composeLinkNoteText(input: { title?: string; userText?: string; description?: string }): string {
  const title = compact(input.title || '');
  const userText = compact(input.userText || '');
  const description = compact(input.description || '');
  const secondary = userText || description;
  return [title, secondary].filter(Boolean).join('\n\n').trim() || title || secondary || '';
}

export function firstNonBlankLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

export function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function safeTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

export function mergeSourceFields<T extends Note>(base: T, next: Partial<T>): T {
  return { ...base, ...next };
}

export const DEFAULT_APP_URL = 'https://links.anishthite.workers.dev';

const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

export function normalizeAppUrl(value) {
  const raw = String(value || DEFAULT_APP_URL).trim() || DEFAULT_APP_URL;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('App URL must start with http:// or https://');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/(links|notes)$/i, '');
  return `${url.origin}${path}`.replace(/\/+$/, '');
}

export function linksApiUrl(appUrl) {
  return `${normalizeAppUrl(appUrl)}/api/links`;
}

export function normalizeTag(input) {
  let tag = String(input || '').trim();
  if (tag.startsWith('#')) tag = tag.slice(1).trim();
  tag = tag.replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!tag || tag.length > 40 || !TAG_RE.test(tag)) return null;
  return tag;
}

export function parseTags(input) {
  const seen = new Set();
  const tags = [];
  for (const part of String(input || '').split(/[\n,]/)) {
    const tag = normalizeTag(part);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
    if (tags.length === 32) break;
  }
  return tags;
}

export function isSavableUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

export function buildCreatePayload({ url, note = '', tagsText = '' }) {
  const sourceUrl = String(url || '').trim();
  if (!isSavableUrl(sourceUrl)) throw new Error('Only http:// and https:// tabs can be saved.');
  const text = String(note || '').trim();
  return {
    sourceUrl,
    ...(text ? { text } : {}),
    tags: parseTags(tagsText),
  };
}

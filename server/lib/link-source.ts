import short from 'short-uuid';

import { composeLinkNoteText } from '../../src/lib/link-note';
import { cleanTags, MAX_TEXT_LEN } from './note-write';

const translator = short();
const TRACKING_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name', 'utm_reader', 'utm_brand', 'utm_social', 'gclid', 'fbclid']);
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const BODY_RE = /<body[^>]*>([\s\S]*?)<\/body>/i;
const YT_PLAYER_RESPONSE_MARKERS = [
  'var ytInitialPlayerResponse = ',
  'ytInitialPlayerResponse = ',
  'window["ytInitialPlayerResponse"] = ',
] as const;

export type LinkExtract = {
  sourceUrl: string;
  sourceUrlNormalized: string;
  sourceTitle: string;
  sourceDescription: string;
  sourceSiteName: string;
  sourceAuthor: string;
  sourcePublishedAt: number | null;
  sourceFetchedAt: number;
  sourceContentText: string;
  sourceContentMarkdown: string;
  sourceStatus: 'ready' | 'failed';
  sourceLastError: string;
};

export async function buildLinkNoteInsert(input: { sourceUrl: unknown; text?: unknown; tags?: unknown }) {
  const sourceUrl = String(input.sourceUrl || '').trim();
  if (!sourceUrl) throw new Error('source url required');
  const normalized = normalizeSourceUrl(sourceUrl);
  const userText = typeof input.text === 'string' ? input.text.trim().slice(0, MAX_TEXT_LEN) : '';
  const tags = cleanTags(input.tags);
  const now = Date.now();
  const extracted = await fetchLinkExtract(normalized, now).catch((error) => failedExtract(normalized, now, error));
  const text = composeLinkNoteText({ title: extracted.sourceTitle, userText, description: extracted.sourceDescription }) || userText || extracted.sourceTitle || normalized;
  return {
    uuid: translator.new(),
    text,
    tags: JSON.stringify(tags),
    color: null,
    positionX: null,
    positionY: null,
    zIndex: 0,
    createdAt: now,
    updatedAt: now,
    tagsUpdatedAt: now,
    contentHash: null,
    ...extracted,
  };
}

export async function refreshLinkNote(existing: { sourceUrl?: string | null; text: string; sourceDescription?: string | null; sourceTitle?: string | null }) {
  const sourceUrl = String(existing.sourceUrl || '').trim();
  if (!sourceUrl) throw new Error('note has no source url');
  const now = Date.now();
  const extracted = await fetchLinkExtract(sourceUrl, now).catch((error) => failedExtract(sourceUrl, now, error));
  const fallbackUserText = existing.text === composeLinkNoteText({ title: existing.sourceTitle || '', description: existing.sourceDescription || '' })
    ? ''
    : existing.text;
  return {
    text: composeLinkNoteText({ title: extracted.sourceTitle, userText: fallbackUserText, description: extracted.sourceDescription }) || existing.text,
    ...extracted,
  };
}

export function normalizeSourceUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = '';
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()));
  kept.sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  const normalized = url.toString();
  return normalized.endsWith('/') && url.pathname === '/' && !url.search ? normalized.slice(0, -1) : normalized;
}

async function fetchLinkExtract(sourceUrl: string, now: number): Promise<LinkExtract> {
  const response = await fetch(sourceUrl, {
    headers: {
      'user-agent': 'links-board/0.1 (+https://links.anishthite.workers.dev)',
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`fetch failed (${response.status})`);
  const html = await response.text();
  const pageUrl = new URL(sourceUrl);
  const youtube = isYouTubeUrl(pageUrl);
  const playerResponse = youtube ? extractYouTubePlayerResponse(html) : null;
  const transcript = playerResponse ? await fetchYouTubeTranscript(playerResponse).catch(() => null) : null;
  const sourceTitle = firstNonEmpty([
    transcript?.title || '',
    readMeta(html, 'property', 'og:title'),
    readMeta(html, 'name', 'twitter:title'),
    capture(html, TITLE_RE),
    pageUrl.hostname.replace(/^www\./, ''),
  ]);
  const sourceDescription = firstNonEmpty([
    transcript?.description || '',
    readMeta(html, 'name', 'description'),
    readMeta(html, 'property', 'og:description'),
    readMeta(html, 'name', 'twitter:description'),
  ]);
  const sourceSiteName = firstNonEmpty([
    readMeta(html, 'property', 'og:site_name'),
    isYouTubeUrl(pageUrl) ? 'YouTube' : '',
    pageUrl.hostname.replace(/^www\./, ''),
  ]);
  const sourceAuthor = firstNonEmpty([
    transcript?.author || '',
    readMeta(html, 'name', 'author'),
    readMeta(html, 'property', 'article:author'),
  ]);
  const sourcePublishedAt = parseTimestamp(firstNonEmpty([
    readMeta(html, 'property', 'article:published_time'),
    readMeta(html, 'name', 'publish_date'),
    readMeta(html, 'name', 'date'),
  ]));
  const sourceContentText = firstNonEmpty([
    transcript?.text || '',
    youtube ? (playerResponse?.videoDetails?.shortDescription || '') : '',
    htmlToText(html),
  ]).slice(0, 40_000);
  return {
    sourceUrl,
    sourceUrlNormalized: sourceUrl,
    sourceTitle,
    sourceDescription,
    sourceSiteName,
    sourceAuthor,
    sourcePublishedAt,
    sourceFetchedAt: now,
    sourceContentText,
    sourceContentMarkdown: sourceContentText,
    sourceStatus: 'ready',
    sourceLastError: '',
  };
}

function failedExtract(sourceUrl: string, now: number, error: unknown): LinkExtract {
  return {
    sourceUrl,
    sourceUrlNormalized: sourceUrl,
    sourceTitle: sourceUrl,
    sourceDescription: '',
    sourceSiteName: hostLabel(sourceUrl),
    sourceAuthor: '',
    sourcePublishedAt: null,
    sourceFetchedAt: now,
    sourceContentText: '',
    sourceContentMarkdown: '',
    sourceStatus: 'failed',
    sourceLastError: String(error instanceof Error ? error.message : error).slice(0, 500),
  };
}

function hostLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

function readMeta(html: string, attr: 'name' | 'property', key: string): string {
  const re = new RegExp(`<meta[^>]+${attr}=["']${escapeRe(key)}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`, 'i');
  const reverseRe = new RegExp(`<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+${attr}=["']${escapeRe(key)}["'][^>]*>`, 'i');
  return decodeHtml(capture(html, re) || capture(html, reverseRe));
}

function capture(text: string, re: RegExp): string {
  return decodeHtml(text.match(re)?.[1]?.trim() || '');
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlToText(html: string): string {
  const body = html.match(BODY_RE)?.[1] || html;
  return decodeHtml(body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6)>/gi, '$&\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n'));
}

function parseTimestamp(value: string): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function isYouTubeUrl(url: URL): boolean {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com';
}

type YouTubePlayerResponse = {
  videoDetails?: { title?: string; author?: string; shortDescription?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YouTubeCaptionTrack[];
    };
  };
};

type YouTubeCaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
};

type YouTubeTranscript = {
  title: string;
  author: string;
  description: string;
  text: string;
};

function extractYouTubePlayerResponse(html: string): YouTubePlayerResponse | null {
  for (const marker of YT_PLAYER_RESPONSE_MARKERS) {
    const start = html.indexOf(marker);
    if (start === -1) continue;
    const json = extractBalancedJson(html, start + marker.length);
    if (!json) continue;
    try {
      return JSON.parse(json) as YouTubePlayerResponse;
    } catch {
      continue;
    }
  }
  return null;
}

function extractBalancedJson(text: string, start: number): string | null {
  const open = text.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

async function fetchYouTubeTranscript(player: YouTubePlayerResponse): Promise<YouTubeTranscript | null> {
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const picked = pickYouTubeCaptionTrack(tracks);
  if (!picked?.baseUrl) return null;
  const url = new URL(picked.baseUrl);
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url.toString(), {
    headers: {
      'user-agent': 'links-board/0.1 (+https://links.anishthite.workers.dev)',
      accept: 'application/json,text/plain,*/*',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`youtube transcript fetch failed (${response.status})`);
  const body = await response.json() as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
  const text = (body.events || [])
    .map((event) => (event.segs || []).map((seg) => decodeHtml(seg.utf8 || '')).join(''))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 40_000);
  if (!text) return null;
  return {
    title: (player.videoDetails?.title || '').trim(),
    author: (player.videoDetails?.author || '').trim(),
    description: (player.videoDetails?.shortDescription || '').trim(),
    text,
  };
}

function pickYouTubeCaptionTrack(tracks: YouTubeCaptionTrack[]): YouTubeCaptionTrack | null {
  if (tracks.length === 0) return null;
  const score = (track: YouTubeCaptionTrack): number => {
    const language = (track.languageCode || '').toLowerCase();
    const generated = track.kind === 'asr' || String(track.vssId || '').startsWith('a.');
    if (!generated && language === 'en') return 50;
    if (!generated && language.startsWith('en-')) return 45;
    if (!generated) return 40;
    if (generated && language === 'en') return 30;
    if (generated && language.startsWith('en-')) return 25;
    return 10;
  };
  return [...tracks].sort((a, b) => score(b) - score(a))[0] || null;
}

function firstNonEmpty(values: string[]): string {
  return values.find((value) => value.trim().length > 0)?.trim() || '';
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

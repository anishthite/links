import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import short from 'short-uuid';
import TurndownService from 'turndown';

import { composeLinkNoteText, compact } from '../../src/lib/link-note';
import { cleanTags, MAX_TEXT_LEN } from './note-write';
import type { Env } from '../env';

const translator = short();
const TRACKING_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name', 'utm_reader', 'utm_brand', 'utm_social', 'gclid', 'fbclid']);
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const BODY_RE = /<body[^>]*>([\s\S]*?)<\/body>/i;
const YT_PLAYER_RESPONSE_MARKERS = [
  'var ytInitialPlayerResponse = ',
  'ytInitialPlayerResponse = ',
  'window["ytInitialPlayerResponse"] = ',
] as const;
const SOURCE_PREVIEW_CHARS = 40_000;
const MAX_CHUNKED_SOURCE_CHARS = 240_000;
const SOURCE_CHUNK_CHARS = 6_000;
const SOURCE_CHUNK_OVERLAP = 500;
const MIN_GOOD_EXTRACT_CHARS = 800;

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

export type LinkExtract = {
  sourceUrl: string;
  sourceUrlNormalized: string;
  sourceTitle: string;
  sourceDescription: string;
  sourceSiteName: string;
  sourceAuthor: string;
  sourcePublishedAt: number | null;
  sourceFetchedAt: number | null;
  sourceContentText: string;
  sourceContentMarkdown: string;
  sourceStatus: 'pending' | 'ready' | 'failed';
  sourceLastError: string;
  sourceFinalUrl: string;
  sourceExtractor: string;
  sourceStatusCode: number | null;
  sourceContentLength: number;
  sourceContentTruncated: boolean;
};

export type LinkSourceChunk = {
  chunkIndex: number;
  heading: string;
  text: string;
  charStart: number;
  charEnd: number;
  createdAt: number;
};

export type LinkExtractionResult = {
  notePatch: LinkExtract & { text: string };
  chunks: LinkSourceChunk[];
};

type LinkExtractWithFullText = LinkExtract & {
  sourceFullContentText: string;
};

type ScraperEnv = Pick<Env, 'LINK_SCRAPER_PROVIDER' | 'LINK_SCRAPER_API_KEY' | 'LINK_SCRAPER_ENDPOINT'>;

type RawFetchResult = {
  html: string;
  finalUrl: string;
  statusCode: number;
};

type ReadableCandidate = {
  title: string;
  description: string;
  siteName: string;
  author: string;
  publishedAt: number | null;
  text: string;
  markdown: string;
  extractor: string;
};

export function buildLinkNoteInsert(input: { sourceUrl: unknown; text?: unknown; tags?: unknown }) {
  const sourceUrl = String(input.sourceUrl || '').trim();
  if (!sourceUrl) throw new Error('source url required');
  const normalized = normalizeSourceUrl(sourceUrl);
  const userText = typeof input.text === 'string' ? input.text.trim().slice(0, MAX_TEXT_LEN) : '';
  const tags = cleanTags(input.tags);
  const now = Date.now();
  const pending = pendingExtract(normalized);
  const text = userText || normalized;
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
    ...pending,
  };
}

export async function refreshLinkNote(
  existing: { sourceUrl?: string | null; text: string; sourceDescription?: string | null; sourceTitle?: string | null },
  env?: ScraperEnv,
): Promise<LinkExtractionResult> {
  const sourceUrl = String(existing.sourceUrl || '').trim();
  if (!sourceUrl) throw new Error('note has no source url');
  const now = Date.now();
  const extracted = await fetchLinkExtract(sourceUrl, now, env).catch((error) => failedExtract(sourceUrl, now, error));
  const fallbackUserText = existing.text === composeLinkNoteText({ title: existing.sourceTitle || '', description: existing.sourceDescription || '' })
    ? ''
    : existing.text;
  const text = composeLinkNoteText({ title: extracted.sourceTitle, userText: fallbackUserText, description: extracted.sourceDescription }) || existing.text;
  return extractionResult(text, extracted, now);
}

export async function extractLinkNote(
  existing: { sourceUrl?: string | null; text: string; sourceDescription?: string | null; sourceTitle?: string | null },
  env?: ScraperEnv,
): Promise<LinkExtractionResult> {
  return refreshLinkNote(existing, env);
}

export async function replaceLinkSourceChunks(db: D1Database, noteUuid: string, chunks: LinkSourceChunk[]): Promise<void> {
  const statements = [db.prepare('DELETE FROM note_source_chunks WHERE note_uuid = ?').bind(noteUuid)];
  for (const chunk of chunks) {
    statements.push(db.prepare(`
      INSERT INTO note_source_chunks
        (note_uuid, chunk_index, heading, text, char_start, char_end, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      noteUuid,
      chunk.chunkIndex,
      chunk.heading || null,
      chunk.text,
      chunk.charStart,
      chunk.charEnd,
      chunk.createdAt,
    ));
  }
  await db.batch(statements as [D1PreparedStatement, ...D1PreparedStatement[]]);
}

export function buildSourceChunks(text: string, now = Date.now()): LinkSourceChunk[] {
  const source = text.slice(0, MAX_CHUNKED_SOURCE_CHARS).trim();
  if (!source) return [];
  const chunks: LinkSourceChunk[] = [];
  let start = 0;
  while (start < source.length) {
    const hardEnd = Math.min(source.length, start + SOURCE_CHUNK_CHARS);
    const end = hardEnd < source.length ? nearestBreak(source, hardEnd, start + Math.floor(SOURCE_CHUNK_CHARS * 0.6)) : hardEnd;
    const chunkText = source.slice(start, end).trim();
    if (chunkText) {
      chunks.push({
        chunkIndex: chunks.length,
        heading: chunkHeading(chunkText),
        text: chunkText,
        charStart: start,
        charEnd: end,
        createdAt: now,
      });
    }
    if (end >= source.length) break;
    start = Math.max(end - SOURCE_CHUNK_OVERLAP, start + 1);
  }
  return chunks;
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

async function fetchLinkExtract(sourceUrl: string, now: number, env?: ScraperEnv): Promise<LinkExtractWithFullText> {
  try {
    const raw = await fetchRawHtml(sourceUrl);
    const pageUrl = new URL(raw.finalUrl || sourceUrl);
    const youtube = isYouTubeUrl(pageUrl);
    const playerResponse = youtube ? extractYouTubePlayerResponse(raw.html) : null;
    const transcript = playerResponse ? await fetchYouTubeTranscript(playerResponse).catch(() => null) : null;
    const candidate = transcript
      ? youtubeCandidate(transcript, playerResponse, raw.html, pageUrl)
      : readableCandidate(raw.html, pageUrl);
    const external = shouldTryExternal(candidate, env)
      ? await fetchExternalExtract(sourceUrl, env, now).catch(() => null)
      : null;
    return readyExtract(sourceUrl, raw.finalUrl, raw.statusCode, now, external || candidate);
  } catch (error) {
    const external = await fetchExternalExtract(sourceUrl, env, now).catch(() => null);
    if (external) return readyExtract(sourceUrl, external.finalUrl || sourceUrl, external.statusCode, now, external);
    throw error;
  }
}

async function fetchRawHtml(sourceUrl: string): Promise<RawFetchResult> {
  const response = await fetch(sourceUrl, {
    headers: {
      'user-agent': 'links-board/0.2 (+https://links.anishthite.workers.dev)',
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`fetch failed (${response.status})`);
  return {
    html: await response.text(),
    finalUrl: response.url || sourceUrl,
    statusCode: response.status,
  };
}

function readyExtract(
  sourceUrl: string,
  finalUrl: string,
  statusCode: number | null,
  now: number,
  candidate: ReadableCandidate & { finalUrl?: string; statusCode?: number | null },
): LinkExtractWithFullText {
  const normalized = normalizeSourceUrl(sourceUrl);
  const text = compactMultiline(candidate.text).slice(0, MAX_CHUNKED_SOURCE_CHARS);
  const markdown = compactMarkdown(candidate.markdown || text).slice(0, MAX_CHUNKED_SOURCE_CHARS);
  const pageUrl = safeUrl(finalUrl || sourceUrl);
  const sourceContentText = text.slice(0, SOURCE_PREVIEW_CHARS);
  return {
    sourceUrl: normalized,
    sourceUrlNormalized: normalized,
    sourceTitle: firstNonEmpty([
      candidate.title,
      pageUrl?.hostname.replace(/^www\./, '') || '',
      normalized,
    ]),
    sourceDescription: candidate.description,
    sourceSiteName: firstNonEmpty([
      candidate.siteName,
      pageUrl?.hostname.replace(/^www\./, '') || '',
    ]),
    sourceAuthor: candidate.author,
    sourcePublishedAt: candidate.publishedAt,
    sourceFetchedAt: now,
    sourceContentText,
    sourceContentMarkdown: markdown.slice(0, SOURCE_PREVIEW_CHARS),
    sourceStatus: 'ready',
    sourceLastError: '',
    sourceFinalUrl: candidate.finalUrl || finalUrl || normalized,
    sourceExtractor: candidate.extractor,
    sourceStatusCode: candidate.statusCode ?? statusCode,
    sourceContentLength: text.length,
    sourceContentTruncated: text.length > SOURCE_PREVIEW_CHARS,
    sourceFullContentText: text,
  };
}

function pendingExtract(sourceUrl: string): LinkExtract {
  return {
    sourceUrl,
    sourceUrlNormalized: sourceUrl,
    sourceTitle: sourceUrl,
    sourceDescription: '',
    sourceSiteName: hostLabel(sourceUrl),
    sourceAuthor: '',
    sourcePublishedAt: null,
    sourceFetchedAt: null,
    sourceContentText: '',
    sourceContentMarkdown: '',
    sourceStatus: 'pending',
    sourceLastError: '',
    sourceFinalUrl: '',
    sourceExtractor: '',
    sourceStatusCode: null,
    sourceContentLength: 0,
    sourceContentTruncated: false,
  };
}

function failedExtract(sourceUrl: string, now: number, error: unknown): LinkExtractWithFullText {
  const normalized = normalizeSourceUrl(sourceUrl);
  return {
    sourceUrl: normalized,
    sourceUrlNormalized: normalized,
    sourceTitle: normalized,
    sourceDescription: '',
    sourceSiteName: hostLabel(normalized),
    sourceAuthor: '',
    sourcePublishedAt: null,
    sourceFetchedAt: now,
    sourceContentText: '',
    sourceContentMarkdown: '',
    sourceStatus: 'failed',
    sourceLastError: String(error instanceof Error ? error.message : error).slice(0, 500),
    sourceFinalUrl: '',
    sourceExtractor: '',
    sourceStatusCode: null,
    sourceContentLength: 0,
    sourceContentTruncated: false,
    sourceFullContentText: '',
  };
}

function extractionResult(text: string, extracted: LinkExtractWithFullText, now: number): LinkExtractionResult {
  const { sourceFullContentText, ...noteExtract } = extracted;
  return {
    notePatch: { text, ...noteExtract },
    chunks: noteExtract.sourceStatus === 'ready' ? buildSourceChunks(sourceFullContentText, now) : [],
  };
}

function readableCandidate(html: string, pageUrl: URL): ReadableCandidate {
  const meta = htmlMetadata(html, pageUrl);
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document, { charThreshold: 300 }).parse();
    if (article?.textContent?.trim()) {
      const markdown = htmlToMarkdown(article.content || '');
      return {
        title: firstNonEmpty([meta.title, article.title || '']),
        description: firstNonEmpty([article.excerpt || '', meta.description]),
        siteName: firstNonEmpty([article.siteName || '', meta.siteName]),
        author: firstNonEmpty([article.byline || '', meta.author]),
        publishedAt: article.publishedTime ? parseTimestamp(article.publishedTime) : meta.publishedAt,
        text: article.textContent,
        markdown: markdown || article.textContent,
        extractor: 'readability',
      };
    }
  } catch {
    // Fall through to body stripping below.
  }
  const text = htmlToText(html);
  return {
    ...meta,
    text,
    markdown: text,
    extractor: 'html-strip',
  };
}

function htmlMetadata(html: string, pageUrl: URL): Omit<ReadableCandidate, 'text' | 'markdown' | 'extractor'> {
  return {
    title: firstNonEmpty([
      readMeta(html, 'property', 'og:title'),
      readMeta(html, 'name', 'twitter:title'),
      htmlToText(capture(html, H1_RE)),
      capture(html, TITLE_RE),
      pageUrl.hostname.replace(/^www\./, ''),
    ]),
    description: firstNonEmpty([
      readMeta(html, 'name', 'description'),
      readMeta(html, 'property', 'og:description'),
      readMeta(html, 'name', 'twitter:description'),
    ]),
    siteName: firstNonEmpty([
      readMeta(html, 'property', 'og:site_name'),
      pageUrl.hostname.replace(/^www\./, ''),
    ]),
    author: firstNonEmpty([
      readMeta(html, 'name', 'author'),
      readMeta(html, 'property', 'article:author'),
    ]),
    publishedAt: parseTimestamp(firstNonEmpty([
      readMeta(html, 'property', 'article:published_time'),
      readMeta(html, 'name', 'publish_date'),
      readMeta(html, 'name', 'date'),
    ])),
  };
}

function youtubeCandidate(transcript: YouTubeTranscript, player: YouTubePlayerResponse | null, html: string, pageUrl: URL): ReadableCandidate {
  const meta = htmlMetadata(html, pageUrl);
  return {
    title: firstNonEmpty([transcript.title, player?.videoDetails?.title || '', meta.title]),
    description: firstNonEmpty([transcript.description, player?.videoDetails?.shortDescription || '', meta.description]),
    siteName: 'YouTube',
    author: firstNonEmpty([transcript.author, player?.videoDetails?.author || '', meta.author]),
    publishedAt: meta.publishedAt,
    text: transcript.text,
    markdown: transcript.text,
    extractor: 'youtube-transcript',
  };
}

function shouldTryExternal(candidate: ReadableCandidate, env?: ScraperEnv): boolean {
  if (!scraperProvider(env)) return false;
  if (candidate.extractor === 'youtube-transcript') return false;
  return compact(candidate.text).length < MIN_GOOD_EXTRACT_CHARS;
}

async function fetchExternalExtract(sourceUrl: string, env: ScraperEnv | undefined, now: number): Promise<(ReadableCandidate & { finalUrl: string; statusCode: number | null }) | null> {
  const provider = scraperProvider(env);
  if (!provider) return null;
  if (provider === 'firecrawl') return fetchFirecrawlExtract(sourceUrl, env);
  if (provider === 'jina') return fetchJinaExtract(sourceUrl, env, now);
  return null;
}

function scraperProvider(env?: ScraperEnv): 'firecrawl' | 'jina' | null {
  const value = (env?.LINK_SCRAPER_PROVIDER || '').trim().toLowerCase();
  if (value === 'firecrawl') return 'firecrawl';
  if (value === 'jina' || value === 'jina-reader') return 'jina';
  return null;
}

async function fetchFirecrawlExtract(sourceUrl: string, env?: ScraperEnv): Promise<ReadableCandidate & { finalUrl: string; statusCode: number | null }> {
  const endpoint = env?.LINK_SCRAPER_ENDPOINT || 'https://api.firecrawl.dev/v2/scrape';
  const headers: HeadersInit = { 'content-type': 'application/json' };
  if (env?.LINK_SCRAPER_API_KEY) headers.authorization = `Bearer ${env.LINK_SCRAPER_API_KEY}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: sourceUrl,
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 60_000,
      parsers: ['pdf'],
      removeBase64Images: true,
      blockAds: true,
    }),
    signal: AbortSignal.timeout(65_000),
  });
  if (!response.ok) throw new Error(`firecrawl failed (${response.status})`);
  const body = await response.json() as {
    success?: boolean;
    data?: {
      markdown?: string;
      html?: string;
      metadata?: Record<string, unknown>;
      warning?: string;
    };
  };
  if (body.success === false) throw new Error('firecrawl returned success=false');
  const data = body.data || {};
  const meta = data.metadata || {};
  const markdown = String(data.markdown || '');
  const text = markdownToPlainText(markdown || htmlToText(String(data.html || '')));
  if (!text.trim()) throw new Error('firecrawl returned empty content');
  return {
    title: stringMeta(meta, ['title', 'ogTitle']),
    description: stringMeta(meta, ['description', 'ogDescription']),
    siteName: stringMeta(meta, ['siteName', 'ogSiteName']),
    author: stringMeta(meta, ['author']),
    publishedAt: parseTimestamp(stringMeta(meta, ['publishedTime', 'article:published_time', 'date'])),
    text,
    markdown: markdown || text,
    extractor: 'firecrawl',
    finalUrl: stringMeta(meta, ['url', 'sourceURL']) || sourceUrl,
    statusCode: numberMeta(meta, ['statusCode']),
  };
}

async function fetchJinaExtract(sourceUrl: string, env: ScraperEnv | undefined, now: number): Promise<ReadableCandidate & { finalUrl: string; statusCode: number | null }> {
  const base = (env?.LINK_SCRAPER_ENDPOINT || 'https://r.jina.ai').replace(/\/+$/, '');
  const headers: HeadersInit = { accept: 'application/json' };
  if (env?.LINK_SCRAPER_API_KEY) headers.authorization = `Bearer ${env.LINK_SCRAPER_API_KEY}`;
  const response = await fetch(`${base}/${sourceUrl}`, {
    headers,
    signal: AbortSignal.timeout(65_000),
  });
  if (!response.ok) throw new Error(`jina reader failed (${response.status})`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await response.json() as {
      data?: { title?: string; url?: string; content?: string; publishedTime?: string; description?: string };
      title?: string;
      url?: string;
      content?: string;
      publishedTime?: string;
      description?: string;
    };
    const data = body.data || body;
    const markdown = String(data.content || '');
    if (!markdown.trim()) throw new Error('jina reader returned empty content');
    return {
      title: String(data.title || ''),
      description: String(data.description || ''),
      siteName: hostLabel(String(data.url || sourceUrl)),
      author: '',
      publishedAt: parseTimestamp(String(data.publishedTime || '')),
      text: markdownToPlainText(markdown),
      markdown,
      extractor: 'jina-reader',
      finalUrl: String(data.url || sourceUrl),
      statusCode: response.status,
    };
  }
  const markdown = await response.text();
  if (!markdown.trim()) throw new Error('jina reader returned empty content');
  return {
    title: firstNonBlankLine(markdown).replace(/^#+\s*/, ''),
    description: '',
    siteName: hostLabel(sourceUrl),
    author: '',
    publishedAt: null,
    text: markdownToPlainText(markdown),
    markdown,
    extractor: 'jina-reader',
    finalUrl: sourceUrl,
    statusCode: response.status,
  };
}

function hostLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
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

function htmlToMarkdown(html: string): string {
  try {
    return compactMarkdown(turndown.turndown(html));
  } catch {
    return htmlToText(html);
  }
}

function markdownToPlainText(markdown: string): string {
  return compactMultiline(markdown
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\r/g, ''));
}

function compactMultiline(text: string): string {
  return decodeHtml(text)
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function compactMarkdown(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
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
      'user-agent': 'links-board/0.2 (+https://links.anishthite.workers.dev)',
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
    .slice(0, MAX_CHUNKED_SOURCE_CHARS);
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

function firstNonBlankLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function chunkHeading(text: string): string {
  return firstNonBlankLine(text)
    .replace(/^#{1,6}\s+/, '')
    .slice(0, 120);
}

function nearestBreak(text: string, target: number, min: number): number {
  const breakpoints = ['\n\n', '\n', '. ', '? ', '! ', ' '];
  for (const marker of breakpoints) {
    const index = text.lastIndexOf(marker, target);
    if (index >= min) return index + marker.length;
  }
  return target;
}

function stringMeta(meta: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function numberMeta(meta: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
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

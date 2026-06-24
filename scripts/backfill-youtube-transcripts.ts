#!/usr/bin/env tsx
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

type Args = {
  sleepMs: number;
  out: string;
};

type NoteRow = {
  uuid: string;
  text: string;
  source_url: string | null;
  source_title: string | null;
  source_description: string | null;
  source_content_text: string | null;
};

type Patch = {
  text: string;
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

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LOCAL_D1_DIR = path.join(REPO, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const DEFAULT_SLEEP_MS = 2500;
const DEFAULT_OUT = path.join(REPO, 'db', 'backups', '2026-06-23-youtube-transcript-remote-updates.sql');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = findLocalNotesDbPath();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const notes = db.prepare(`
    SELECT uuid, text, source_url, source_title, source_description, source_content_text
    FROM notes
    WHERE (source_url LIKE 'https://www.youtube.com/%' OR source_url LIKE 'https://youtu.be/%')
      AND (source_content_text IS NULL OR source_content_text = '')
    ORDER BY created_at ASC
  `).all() as NoteRow[];

  console.log(`[youtube-backfill] db=${path.relative(REPO, dbPath)}`);
  console.log(`[youtube-backfill] pending=${notes.length} sleepMs=${args.sleepMs}`);

  const updates: Array<{ uuid: string; patch: Patch }> = [];
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]!;
    const patch = await extractYouTubePatch(note);
    db.prepare(`
      UPDATE notes
      SET text = ?,
          source_url = ?,
          source_url_normalized = ?,
          source_title = ?,
          source_description = ?,
          source_site_name = ?,
          source_author = ?,
          source_published_at = ?,
          source_fetched_at = ?,
          source_content_text = ?,
          source_content_markdown = ?,
          source_status = ?,
          source_last_error = ?
      WHERE uuid = ?
    `).run(
      patch.text,
      patch.sourceUrl,
      patch.sourceUrlNormalized,
      patch.sourceTitle,
      patch.sourceDescription,
      patch.sourceSiteName,
      patch.sourceAuthor,
      patch.sourcePublishedAt,
      patch.sourceFetchedAt,
      patch.sourceContentText,
      patch.sourceContentMarkdown,
      patch.sourceStatus,
      patch.sourceLastError,
      note.uuid,
    );
    updates.push({ uuid: note.uuid, patch });
    if (patch.sourceContentText.trim()) ok += 1;
    else failed += 1;
    console.log(`[youtube-backfill] ${i + 1}/${notes.length} ${note.uuid} status=${patch.sourceStatus} chars=${patch.sourceContentText.length}`);
    if (i < notes.length - 1) await sleep(args.sleepMs);
  }

  writeFileSync(args.out, buildRemoteSql(updates));
  const after = db.prepare(`
    SELECT
      COUNT(*) AS youtube_notes,
      SUM(CASE WHEN source_content_text IS NULL OR source_content_text = '' THEN 1 ELSE 0 END) AS youtube_empty
    FROM notes
    WHERE (source_url LIKE 'https://www.youtube.com/%' OR source_url LIKE 'https://youtu.be/%')
  `).get() as { youtube_notes: number; youtube_empty: number };

  console.log(`[youtube-backfill] wrote ${path.relative(REPO, args.out)}`);
  console.log(JSON.stringify({ processed: notes.length, ok, failed, after }, null, 2));
}

function parseArgs(argv: string[]): Args {
  let sleepMs = DEFAULT_SLEEP_MS;
  let out = DEFAULT_OUT;
  for (const arg of argv) {
    if (arg.startsWith('--sleep-ms=')) sleepMs = clampInt(arg.slice('--sleep-ms='.length), DEFAULT_SLEEP_MS);
    else if (arg.startsWith('--out=')) out = path.resolve(REPO, arg.slice('--out='.length));
  }
  return { sleepMs, out };
}

function clampInt(raw: string, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.trunc(value);
}

function findLocalNotesDbPath(): string {
  if (!existsSync(LOCAL_D1_DIR)) throw new Error('Local Wrangler D1 directory missing.');
  const files = readdirSync(LOCAL_D1_DIR)
    .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
    .map((name) => path.join(LOCAL_D1_DIR, name));
  for (const file of files) {
    const db = new Database(file, { readonly: true });
    try {
      const row = db.prepare("select 1 as ok from sqlite_master where type='table' and name='notes'").get() as { ok?: number } | undefined;
      if (row?.ok === 1) return file;
    } finally {
      db.close();
    }
  }
  throw new Error('Could not find local D1 sqlite with notes table.');
}

function buildRemoteSql(updates: Array<{ uuid: string; patch: Patch }>): string {
  const lines = ['PRAGMA defer_foreign_keys=TRUE;'];
  for (const { uuid, patch } of updates) {
    lines.push(
      'UPDATE notes SET ' +
      `text = ${sql(patch.text)}, ` +
      `source_url = ${sql(patch.sourceUrl)}, ` +
      `source_url_normalized = ${sql(patch.sourceUrlNormalized)}, ` +
      `source_title = ${sql(patch.sourceTitle)}, ` +
      `source_description = ${sql(patch.sourceDescription)}, ` +
      `source_site_name = ${sql(patch.sourceSiteName)}, ` +
      `source_author = ${sql(patch.sourceAuthor)}, ` +
      `source_published_at = ${sqlNum(patch.sourcePublishedAt)}, ` +
      `source_fetched_at = ${sqlNum(patch.sourceFetchedAt)}, ` +
      `source_content_text = ${sql(patch.sourceContentText)}, ` +
      `source_content_markdown = ${sql(patch.sourceContentMarkdown)}, ` +
      `source_status = ${sql(patch.sourceStatus)}, ` +
      `source_last_error = ${sql(patch.sourceLastError)} ` +
      `WHERE uuid = ${sql(uuid)};`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function sql(value: string | null | undefined): string {
  if (value == null) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNum(value: number | null | undefined): string {
  return value == null ? 'NULL' : String(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractYouTubePatch(note: NoteRow): Promise<Patch> {
  const sourceUrl = String(note.source_url || '').trim();
  const now = Date.now();
  try {
    const html = await fetch(sourceUrl, {
      headers: {
        'user-agent': 'links-board/0.1 (+https://links.anishthite.workers.dev)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    }).then((res) => {
      if (!res.ok) throw new Error(`fetch failed (${res.status})`);
      return res.text();
    });
    const player = extractPlayerResponse(html);
    const pageTitle = extractHtmlTitle(html);
    const title = compact(player?.videoDetails?.title || pageTitle || hostLabel(sourceUrl) || sourceUrl);
    const description = compact(player?.videoDetails?.shortDescription || '');
    const author = compact(player?.videoDetails?.author || '');
    const transcript = player ? await fetchTranscript(player).catch(() => '') : '';
    const sourceContentText = compact(transcript || description || title).slice(0, 40_000);
    const text = composeLinkText(title, note.text, note.source_title, note.source_description, description);
    return {
      text,
      sourceUrl,
      sourceUrlNormalized: sourceUrl,
      sourceTitle: title,
      sourceDescription: description,
      sourceSiteName: 'YouTube',
      sourceAuthor: author,
      sourcePublishedAt: null,
      sourceFetchedAt: now,
      sourceContentText,
      sourceContentMarkdown: sourceContentText,
      sourceStatus: 'ready',
      sourceLastError: '',
    };
  } catch (error) {
    return {
      text: note.text,
      sourceUrl,
      sourceUrlNormalized: sourceUrl,
      sourceTitle: compact(note.source_title || sourceUrl),
      sourceDescription: compact(note.source_description || ''),
      sourceSiteName: 'YouTube',
      sourceAuthor: '',
      sourcePublishedAt: null,
      sourceFetchedAt: now,
      sourceContentText: '',
      sourceContentMarkdown: '',
      sourceStatus: 'failed',
      sourceLastError: String(error instanceof Error ? error.message : error).slice(0, 500),
    };
  }
}

function extractPlayerResponse(html: string): { videoDetails?: { title?: string; author?: string; shortDescription?: string }; captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<{ baseUrl?: string; languageCode?: string; kind?: string; vssId?: string }> } } } | null {
  const marker = 'var ytInitialPlayerResponse = ';
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = html.indexOf('{', markerIndex + marker.length);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i]!;
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
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  return null;
}

async function fetchTranscript(player: NonNullable<ReturnType<typeof extractPlayerResponse>>): Promise<string> {
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (tracks.length === 0) return '';
  const pick = [...tracks].sort((a, b) => scoreTrack(b) - scoreTrack(a))[0];
  if (!pick?.baseUrl) return '';
  let url = pick.baseUrl.replace(/([?&])fmt=[^&]*/g, '').replace(/[?&]$/, '');
  url += (url.includes('?') ? '&' : '?') + 'fmt=json3';
  const text = await fetch(url, {
    headers: {
      'user-agent': 'links-board/0.1 (+https://links.anishthite.workers.dev)',
      accept: 'application/json,text/plain,*/*',
    },
    signal: AbortSignal.timeout(20_000),
  }).then((res) => res.text());
  if (!text.trim()) return '';
  const body = JSON.parse(text) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
  return compact((body.events || [])
    .map((event) => (event.segs || []).map((seg) => decodeHtml(seg.utf8 || '')).join(''))
    .join('\n'));
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtml(compact(match?.[1] || '').replace(/\s*-\s*YouTube$/i, ''));
}

function scoreTrack(track: { languageCode?: string; kind?: string; vssId?: string }): number {
  const language = String(track.languageCode || '').toLowerCase();
  const generated = track.kind === 'asr' || String(track.vssId || '').startsWith('a.');
  if (!generated && language === 'en') return 50;
  if (!generated && language.startsWith('en-')) return 45;
  if (!generated) return 40;
  if (generated && language === 'en') return 30;
  if (generated && language.startsWith('en-')) return 25;
  return 10;
}

function composeLinkText(title: string, existingText: string, oldTitle: string | null, oldDescription: string | null, newDescription: string): string {
  const oldComposed = compact([compact(oldTitle || ''), compact(oldDescription || '')].filter(Boolean).join('\n\n'));
  const current = compact(existingText || '');
  const fallbackUserText = current && current !== oldComposed ? current : '';
  return compact([title, fallbackUserText || newDescription].filter(Boolean).join('\n\n')) || title;
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hostLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
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

main().catch((err) => {
  console.error('[youtube-backfill] failed', err);
  process.exit(1);
});

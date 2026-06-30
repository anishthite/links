import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import { buildLinkNoteInsert, buildSourceChunks, normalizeSourceUrl, refreshLinkNote, replaceLinkSourceChunks } from '../server/lib/link-source';
import { freshShimDb } from './helpers/d1-shim';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATIONS = [
  path.join(MIGRATIONS_DIR, '0001_initial.sql'),
  path.join(MIGRATIONS_DIR, '0011_links_metadata.sql'),
  path.join(MIGRATIONS_DIR, '0012_source_chunks.sql'),
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('link source extraction', () => {
  it('normalizes tracking params off YouTube URLs', () => {
    expect(normalizeSourceUrl('https://www.youtube.com/watch?v=abc123&utm_source=test&fbclid=123')).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('creates link notes as pending without fetching', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const row = buildLinkNoteInsert({ sourceUrl: 'https://example.com/post?utm_source=test', text: 'read this', tags: ['research'] });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(row.sourceUrl).toBe('https://example.com/post');
    expect(row.sourceStatus).toBe('pending');
    expect(row.text).toBe('read this');
    expect(row.tags).toBe(JSON.stringify(['research']));
  });

  it('extracts readable article content and builds chunks', async () => {
    const html = `
      <html>
        <head>
          <title>Shell title</title>
          <meta name="description" content="Readable description">
          <meta property="og:site_name" content="Example Journal">
        </head>
        <body>
          <nav>Subscribe Login Trending Topics</nav>
          <article>
            <h1>Readable Link Scraping</h1>
            <p>First paragraph about preserving the useful article body.</p>
            <p>Second paragraph with enough specific text for retrieval and memory.</p>
          </article>
          <footer>Footer chrome</footer>
        </body>
      </html>
    `;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })));

    const { notePatch, chunks } = await refreshLinkNote({
      sourceUrl: 'https://example.com/readable',
      text: 'my note',
      sourceTitle: '',
      sourceDescription: '',
    });

    expect(notePatch.sourceStatus).toBe('ready');
    expect(notePatch.sourceExtractor).toMatch(/readability|html-strip/);
    expect(notePatch.sourceTitle).toContain('Readable Link Scraping');
    expect(notePatch.sourceDescription).toBeTruthy();
    expect(notePatch.sourceContentText).toContain('preserving the useful article body');
    expect(notePatch.sourceContentLength).toBeGreaterThan(80);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.text).toContain('preserving the useful article body');
  });

  it('stores YouTube transcript text when captions exist', async () => {
    const watchHtml = `
      <html>
        <head><title>Ignored title</title></head>
        <body>
          <script>
            var ytInitialPlayerResponse = {
              "videoDetails": {
                "title": "How to Setup a Local Coding Agent on macOS",
                "author": "Kyle Howells",
                "shortDescription": "Practical guide"
              },
              "captions": {
                "playerCaptionsTracklistRenderer": {
                  "captionTracks": [
                    {"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=srv3","languageCode":"en","kind":"asr"}
                  ]
                }
              }
            };
          </script>
        </body>
      </html>
    `;
    const transcript = {
      events: [
        { segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { segs: [{ utf8: 'Agents can read transcripts.' }] },
      ],
    };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(watchHtml, { status: 200, headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(transcript), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { notePatch } = await refreshLinkNote({
      sourceUrl: 'https://www.youtube.com/watch?v=abc',
      text: '',
      sourceTitle: '',
      sourceDescription: '',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('fmt=json3');
    expect(notePatch.sourceExtractor).toBe('youtube-transcript');
    expect(notePatch.sourceTitle).toBe('How to Setup a Local Coding Agent on macOS');
    expect(notePatch.sourceAuthor).toBe('Kyle Howells');
    expect(notePatch.sourceSiteName).toBe('YouTube');
    expect(notePatch.sourceDescription).toBe('Practical guide');
    expect(notePatch.sourceContentText).toContain('Hello world');
    expect(notePatch.sourceContentText).toContain('Agents can read transcripts.');
    expect(notePatch.text).toContain('How to Setup a Local Coding Agent on macOS');
  });

  it('replaces persisted source chunks for a note', async () => {
    const db = freshShimDb(MIGRATIONS);
    const now = Date.now();
    await db.prepare(`
      INSERT INTO notes (uuid, text, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind('chunk-note', 'chunk me', '[]', now, now).run();

    await replaceLinkSourceChunks(db, 'chunk-note', buildSourceChunks('alpha '.repeat(1400), now));
    const firstCount = await db.prepare('SELECT COUNT(*) AS count FROM note_source_chunks WHERE note_uuid = ?')
      .bind('chunk-note')
      .first<{ count: number }>();
    expect(firstCount?.count).toBeGreaterThan(1);

    await replaceLinkSourceChunks(db, 'chunk-note', buildSourceChunks('short replacement', now + 1));
    const rows = await db.prepare('SELECT chunk_index, text FROM note_source_chunks WHERE note_uuid = ? ORDER BY chunk_index')
      .bind('chunk-note')
      .all<{ chunk_index: number; text: string }>();
    expect(rows.results).toEqual([{ chunk_index: 0, text: 'short replacement' }]);
  });
});

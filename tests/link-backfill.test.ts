import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../server';
import { runLinkScrapeBackfill } from '../server/lib/link-backfill';
import { freshShimDb } from './helpers/d1-shim';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATIONS = [
  path.join(MIGRATIONS_DIR, '0001_initial.sql'),
  path.join(MIGRATIONS_DIR, '0002_tag_suggestions.sql'),
  path.join(MIGRATIONS_DIR, '0003_tags_standalone.sql'),
  path.join(MIGRATIONS_DIR, '0011_links_metadata.sql'),
  path.join(MIGRATIONS_DIR, '0012_source_chunks.sql'),
];

type Env = { DB: D1Database; LINK_BACKFILL_LIMIT?: string };

let env: Env;

beforeEach(() => {
  env = { DB: freshShimDb(MIGRATIONS) };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('link scrape backfill', () => {
  it('builds chunks for ready link notes without re-fetching when preview text exists', async () => {
    const now = 1782198326912;
    await seedLink(env, {
      uuid: 'missing-chunks',
      status: 'ready',
      fetchedAt: now,
      contentText: 'legacy preview only',
      extractor: 'legacy',
      contentLength: 19,
      createdAt: now - 1000,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(articleHtml('Backfilled Article'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runLinkScrapeBackfill(env, { limit: 5, now });

    expect(result).toMatchObject({ considered: 1, refreshed: 1, failed: 0, limit: 5, uuids: ['missing-chunks'] });
    expect(fetchMock).not.toHaveBeenCalled();
    const note = await env.DB.prepare('SELECT source_status, source_extractor, source_content_text FROM notes WHERE uuid = ?')
      .bind('missing-chunks')
      .first<{ source_status: string; source_extractor: string; source_content_text: string }>();
    expect(note?.source_status).toBe('ready');
    expect(note?.source_extractor).toBe('legacy');
    expect(note?.source_content_text).toBe('legacy preview only');
    const chunks = await chunkCount(env, 'missing-chunks');
    expect(chunks).toBeGreaterThan(0);
  });

  it('skips fresh pending rows but retries stale failures', async () => {
    const now = 1782198326912;
    await seedLink(env, {
      uuid: 'fresh-pending',
      status: 'pending',
      createdAt: now - 60_000,
    });
    await seedLink(env, {
      uuid: 'stale-failure',
      status: 'failed',
      fetchedAt: now - 25 * 60 * 60 * 1000,
      createdAt: now - 30 * 60 * 60 * 1000,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(articleHtml('Retry Article'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runLinkScrapeBackfill(env, { limit: 10, now });

    expect(result.uuids).toEqual(['stale-failure']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await chunkCount(env, 'fresh-pending')).toBe(0);
    expect(await chunkCount(env, 'stale-failure')).toBeGreaterThan(0);
  });

  it('runs from the authenticated notes API endpoint', async () => {
    const now = 1782198326912;
    await seedLink(env, {
      uuid: 'manual-backfill',
      status: 'ready',
      fetchedAt: now,
      contentText: 'legacy preview only',
      extractor: 'legacy',
      contentLength: 19,
      createdAt: now - 1000,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(articleHtml('Manual Article'), { status: 200 })));

    const res = await app.fetch(new Request('http://test.local/api/notes/backfill-link-sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 1 }),
    }), env);

    expect(res.status).toBe(200);
    const body = await res.json() as { considered: number; refreshed: number; uuids: string[] };
    expect(body).toMatchObject({ considered: 1, refreshed: 1, uuids: ['manual-backfill'] });
  });
});

async function seedLink(env: Env, input: {
  uuid: string;
  status?: string | null;
  fetchedAt?: number | null;
  contentText?: string | null;
  extractor?: string | null;
  contentLength?: number | null;
  createdAt?: number;
}) {
  const createdAt = input.createdAt ?? 1782198326912;
  await env.DB.prepare(`
    INSERT INTO notes (
      uuid, text, tags, z_index, created_at, updated_at, tags_updated_at,
      source_url, source_url_normalized, source_title, source_description, source_site_name,
      source_status, source_fetched_at, source_content_text, source_extractor, source_content_length
    ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.uuid,
    'Backfill target',
    '[]',
    createdAt,
    createdAt,
    createdAt,
    `https://example.com/${input.uuid}`,
    `https://example.com/${input.uuid}`,
    'Backfill target',
    '',
    'Example',
    input.status ?? null,
    input.fetchedAt ?? null,
    input.contentText ?? null,
    input.extractor ?? null,
    input.contentLength ?? null,
  ).run();
}

async function chunkCount(env: Env, uuid: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM note_source_chunks WHERE note_uuid = ?')
    .bind(uuid)
    .first<{ count: number }>();
  return Number(row?.count || 0);
}

function articleHtml(title: string): string {
  return `
    <html>
      <head><title>${title}</title><meta name="description" content="Backfill description"></head>
      <body>
        <article>
          <h1>${title}</h1>
          <p>${title} has a full body that should be extracted into source chunks.</p>
          <p>The missing fields are filled by the scrape backfill job.</p>
        </article>
      </body>
    </html>
  `;
}

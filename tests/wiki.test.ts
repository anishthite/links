import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { app } from '../server/index';
import { normalizeWikiSlug } from '../server/lib/wiki';
import { freshShimDb } from './helpers/d1-shim';

type Env = { DB: D1Database };

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATIONS = [
  path.join(MIGRATIONS_DIR, '0001_initial.sql'),
  path.join(MIGRATIONS_DIR, '0010_wiki_pages.sql'),
  path.join(MIGRATIONS_DIR, '0011_links_metadata.sql'),
];

function env(): Env {
  return { DB: freshShimDb(MIGRATIONS) };
}

async function call(env: Env, method: string, reqPath: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', accept: 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.fetch(new Request(`http://test.local${reqPath}`, init), env);
}

describe('wiki routes', () => {
  it('creates, searches, reads, updates, and logs wiki pages', async () => {
    const e = env();
    await e.DB.prepare("INSERT INTO notes (uuid, text, tags, created_at, updated_at) VALUES ('note1', 'Semantic layout notes', '[\"layout\"]', 10, 20)").run();

    const created = await call(e, 'POST', '/api/wiki/pages', {
      title: 'Semantic Layout',
      kind: 'topic',
      contentMd: '# Semantic Layout\n\nCompiled understanding.',
      sourceRefs: [{ uuid: 'note1', updatedAt: 20, excerpt: 'Semantic layout notes' }],
      relatedSlugs: ['Whiteboard'],
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { page: { slug: string; relatedSlugs: string[]; sourceRefs: Array<{ uuid: string }> } };
    expect(createdBody.page.slug).toBe('semantic-layout');
    expect(createdBody.page.relatedSlugs).toEqual(['whiteboard']);
    expect(createdBody.page.sourceRefs[0].uuid).toBe('note1');

    const search = await call(e, 'GET', '/api/wiki/search?q=layout');
    const searchBody = await search.json() as { pages: Array<{ slug: string }> };
    expect(searchBody.pages.map((page) => page.slug)).toEqual(['semantic-layout']);

    const read = await call(e, 'GET', '/api/wiki/pages/semantic-layout');
    expect(read.status).toBe(200);

    const updated = await call(e, 'PATCH', '/api/wiki/pages/semantic-layout', { contentMd: '# Semantic Layout\n\nUpdated.', summary: 'tightened page' });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json() as { page: { contentMd: string } };
    expect(updatedBody.page.contentMd).toContain('Updated');

    const events = await call(e, 'GET', '/api/wiki/events');
    const eventsBody = await events.json() as { events: Array<{ summary: string; pageSlug: string }> };
    expect(eventsBody.events.map((event) => event.pageSlug)).toEqual(['semantic-layout', 'semantic-layout']);
    expect(eventsBody.events[0].summary).toBe('tightened page');
  });

  it('rejects invalid page kinds', async () => {
    const res = await call(env(), 'POST', '/api/wiki/pages', { title: 'Bad', kind: 'folder', contentMd: 'Nope' });
    expect(res.status).toBe(400);
  });
});

describe('normalizeWikiSlug', () => {
  it('normalizes titles into stable slugs', () => {
    expect(normalizeWikiSlug('  Café / Semantic Layout!!  ')).toBe('cafe-semantic-layout');
  });
});

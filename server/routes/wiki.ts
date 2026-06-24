import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';

import type { Env, Variables } from '../env';
import { db, schema } from '../../db/client';
import {
  cleanRelatedSlugs,
  cleanSourceRefs,
  cleanWikiContent,
  cleanWikiTitle,
  normalizeWikiKind,
  normalizeWikiSlug,
  searchWikiPages,
  upsertWikiPage,
  wikiEventToWire,
  wikiPageToWire,
} from '../lib/wiki';

export const wikiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

wikiRoutes.get('/pages', async (c) => {
  try {
    const rows = await db(c.env.DB).select().from(schema.wikiPages).orderBy(desc(schema.wikiPages.updatedAt)).all();
    return c.json({ pages: rows.map(wikiPageToWire) });
  } catch (err) {
    console.error('[wiki] list pages failed', err);
    return c.json({ error: 'list pages failed', detail: String(err) }, 500);
  }
});

wikiRoutes.get('/search', async (c) => {
  try {
    const query = c.req.query('q') || '';
    const limit = clampLimit(Number(c.req.query('limit')) || 20);
    const pages = await searchWikiPages(c.env.DB, query, limit);
    return c.json({ pages, search: { query, returned: pages.length } });
  } catch (err) {
    console.error('[wiki] search failed', err);
    return c.json({ error: 'search failed', detail: String(err) }, 500);
  }
});

wikiRoutes.get('/events', async (c) => {
  try {
    const limit = clampLimit(Number(c.req.query('limit')) || 50, 100);
    const rows = await db(c.env.DB).select().from(schema.wikiEvents).orderBy(desc(schema.wikiEvents.createdAt)).limit(limit).all();
    return c.json({ events: rows.map(wikiEventToWire) });
  } catch (err) {
    console.error('[wiki] list events failed', err);
    return c.json({ error: 'list events failed', detail: String(err) }, 500);
  }
});

wikiRoutes.get('/pages/:slug', async (c) => {
  const slug = normalizeWikiSlug(c.req.param('slug'));
  if (!slug) return c.json({ error: 'invalid slug' }, 400);
  try {
    const row = await db(c.env.DB).select().from(schema.wikiPages).where(eq(schema.wikiPages.slug, slug)).get();
    if (!row) return c.json({ error: 'wiki page not found' }, 404);
    return c.json({ page: wikiPageToWire(row) });
  } catch (err) {
    console.error('[wiki] get page failed', err);
    return c.json({ error: 'get page failed', detail: String(err) }, 500);
  }
});

wikiRoutes.post('/pages', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await upsertWikiPage(c.env.DB, body as Parameters<typeof upsertWikiPage>[1]);
    if ('error' in result) return c.json({ error: result.error }, 400);
    return c.json({ page: result }, 201);
  } catch (err) {
    console.error('[wiki] create page failed', err);
    return c.json({ error: 'create page failed', detail: String(err) }, 500);
  }
});

wikiRoutes.patch('/pages/:slug', async (c) => {
  const slug = normalizeWikiSlug(c.req.param('slug'));
  if (!slug) return c.json({ error: 'invalid slug' }, 400);
  try {
    const d = db(c.env.DB);
    const existing = await d.select().from(schema.wikiPages).where(eq(schema.wikiPages.slug, slug)).get();
    if (!existing) return c.json({ error: 'wiki page not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const title = body.title === undefined ? existing.title : cleanWikiTitle(body.title);
    const kind = body.kind === undefined ? existing.kind : normalizeWikiKind(body.kind);
    const contentMd = body.contentMd === undefined ? existing.contentMd : cleanWikiContent(body.contentMd);
    const sourceRefs = body.sourceRefs === undefined ? JSON.parse(existing.sourceRefsJson) : cleanSourceRefs(body.sourceRefs);
    const relatedSlugs = body.relatedSlugs === undefined ? JSON.parse(existing.relatedSlugsJson) : cleanRelatedSlugs(body.relatedSlugs);
    const result = await upsertWikiPage(c.env.DB, {
      slug,
      title,
      kind,
      contentMd,
      sourceRefs,
      relatedSlugs,
      action: 'update',
      summary: body.summary,
    });
    if ('error' in result) return c.json({ error: result.error }, 400);
    return c.json({ page: result });
  } catch (err) {
    console.error('[wiki] update page failed', err);
    return c.json({ error: 'update page failed', detail: String(err) }, 500);
  }
});

function clampLimit(n: number, max = 50): number {
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.trunc(n))) : 20;
}

// Tag-management API. Standalone routes for renaming a tag across the corpus
// or removing a tag from every note. No UI yet — exposed for scripting and
// future tag-management screen (L-001 in implementation-notes/2026-06-02-tags-standalone.html).
//
// POST   /api/tags/rename   body { from, to }   → { renamed }
// DELETE /api/tags/:tag                          → { removed }
//
// Both bump tags_updated_at on touched rows (not updated_at) — these are
// metadata operations and should not reshuffle the board.

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import type { Env, Variables } from '../env';
import { db, schema } from '../../db/client';
import { normalizeTag } from '../../src/lib/tags';

export const tagsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Pure helper: apply rename/delete to a tag list, return the new list and
 *  whether anything actually changed. Exported so it can be unit-tested
 *  without standing up a Hono fetch loop. */
export function applyTagRename(tags: string[], from: string, to: string | null): { next: string[]; changed: boolean } {
  if (!tags.includes(from)) return { next: tags, changed: false };
  const seen = new Set<string>();
  const next: string[] = [];
  for (const t of tags) {
    const mapped = t === from ? to : t;
    if (mapped === null) continue;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  // True even if `to` was a duplicate (semantic change still happened: from removed).
  return { next, changed: true };
}

tagsRoutes.post('/rename', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { from?: unknown; to?: unknown };
    const from = normalizeTag(body.from);
    const to = normalizeTag(body.to);
    if (!from) return c.json({ error: 'invalid `from`' }, 400);
    if (!to) return c.json({ error: 'invalid `to`' }, 400);
    if (from === to) return c.json({ renamed: 0 });

    const d = db(c.env.DB);
    // SQLite json_each scan is cheap at this corpus size; switch to a junction
    // table when notes pass ~50k. (L-001.)
    const rows = await d.select().from(schema.notes).all();
    const now = Date.now();
    let renamed = 0;
    for (const r of rows) {
      const parsed = safeParseTags(r.tags);
      const { next, changed } = applyTagRename(parsed, from, to);
      if (!changed) continue;
      await d.update(schema.notes)
        .set({ tags: JSON.stringify(next), tagsUpdatedAt: now })
        .where(eq(schema.notes.uuid, r.uuid))
        .run();
      renamed++;
    }
    return c.json({ renamed });
  } catch (err) {
    console.error('[tags] rename failed', err);
    return c.json({ error: 'rename failed', detail: String(err) }, 500);
  }
});

tagsRoutes.delete('/:tag', async (c) => {
  const raw = c.req.param('tag');
  // The param is URL-decoded by Hono; normalize as a user-typed tag.
  const tag = normalizeTag(decodeURIComponent(raw ?? ''));
  if (!tag) return c.json({ error: 'invalid tag' }, 400);

  try {
    const d = db(c.env.DB);
    const rows = await d.select().from(schema.notes).all();
    const now = Date.now();
    let removed = 0;
    for (const r of rows) {
      const parsed = safeParseTags(r.tags);
      const { next, changed } = applyTagRename(parsed, tag, null);
      if (!changed) continue;
      await d.update(schema.notes)
        .set({ tags: JSON.stringify(next), tagsUpdatedAt: now })
        .where(eq(schema.notes.uuid, r.uuid))
        .run();
      removed++;
    }
    return c.json({ removed });
  } catch (err) {
    console.error('[tags] delete failed', err);
    return c.json({ error: 'delete failed', detail: String(err) }, 500);
  }
});

function safeParseTags(jsonStr: string | null | undefined): string[] {
  if (!jsonStr) return [];
  try {
    const v = JSON.parse(jsonStr);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}


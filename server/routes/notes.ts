// Notes API. Tags are now a first-class field on the note, NOT derived from
// inline `#hashtags` in text. See implementation-notes/2026-06-02-tags-standalone.html.
//
// Contract:
//   - POST   /api/notes                     body { text?, tags?, sourceUrl? }
//   - PATCH  /api/notes/:uuid               body { text?, tags? } (≥1 required)
//   - POST   /api/notes/:uuid/refresh-link
//   - DELETE /api/notes/:uuid
//   - POST   /api/notes/:uuid/accept-suggestion   body { tags? }
//   - POST   /api/notes/:uuid/reject-suggestion   body { tags? }

import { Hono } from 'hono';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Env, Variables } from '../env';
import { db, schema } from '../../db/client';
import { MAX_TAGS_PER_NOTE, MAX_TEXT_LEN, buildNoteInsert, cleanTags } from '../lib/note-write';
import { buildLinkNoteInsert, refreshLinkNote } from '../lib/link-source';
import { absorbInlineHashtags, unionTagsOrdered } from '../../src/lib/tags';

export const notesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/notes — full list, reverse chronological by updated_at.
// LEFT JOIN tag_suggestions: pending legacy/imported review rows become
// `note.pendingSuggestion`. New link auto-tags write directly to notes.tags.
notesRoutes.get('/', async (c) => {
  try {
    const rows = await db(c.env.DB)
      .select({ note: schema.notes, sugg: schema.tagSuggestions })
      .from(schema.notes)
      .leftJoin(
        schema.tagSuggestions,
        and(
          eq(schema.tagSuggestions.uuid, schema.notes.uuid),
          isNull(schema.tagSuggestions.appliedAt),
          ne(schema.tagSuggestions.confidence, 'high'),
        ),
      )
      .orderBy(desc(schema.notes.updatedAt));
    return c.json({ notes: rows.map(toWire) });
  } catch (err) {
    console.error('[notes] list failed', err);
    return c.json({ error: 'list failed', detail: String(err) }, 500);
  }
});

// POST /api/notes  body { text?, tags?, sourceUrl? }
notesRoutes.post('/', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; tags?: unknown; sourceUrl?: unknown };
    const hasSourceUrl = typeof body.sourceUrl === 'string' && body.sourceUrl.trim().length > 0;
    if (!hasSourceUrl && (typeof body.text !== 'string' || body.text.trim().length === 0)) {
      return c.json({ error: 'text or sourceUrl required' }, 400);
    }
    const row = hasSourceUrl
      ? await buildLinkNoteInsert({ sourceUrl: body.sourceUrl, text: body.text, tags: body.tags })
      : buildNoteInsert(body.tags, body.text as string);
    await db(c.env.DB).insert(schema.notes).values(row);
    return c.json({ note: { ...row } }, 201);
  } catch (err) {
    console.error('[notes] create failed', err);
    return c.json({ error: 'create failed', detail: String(err) }, 500);
  }
});

// PATCH /api/notes/:uuid  body { text?, tags? }
//   - text only        → bumps updated_at; tags_updated_at untouched.
//   - tags only        → bumps tags_updated_at only (board sort preserved).
//   - both             → bumps both timestamps.
// At least one of {text, tags} must be present.
notesRoutes.patch('/:uuid', async (c) => {
  const uuid = c.req.param('uuid');
  if (!uuid) return c.json({ error: 'uuid required' }, 400);

  try {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; tags?: unknown };
    const hasText = typeof body.text === 'string';
    const hasTags = body.tags !== undefined;
    if (!hasText && !hasTags) {
      return c.json({ error: 'text or tags required' }, 400);
    }
    if (hasText && (body.text as string).trim().length === 0) {
      return c.json({ error: 'text required' }, 400);
    }

    const d = db(c.env.DB);
    const existing = await d.select().from(schema.notes).where(eq(schema.notes.uuid, uuid)).get();
    if (!existing) return c.json({ error: 'note not found' }, 404);

    const now = Date.now();
    const patch: Partial<typeof schema.notes.$inferInsert> = {};
    // Inline-hashtag absorb+strip for PATCH. Strip ALWAYS runs when hasText
    // so muscle-memory `#idea` litter gets cleaned even when the tag was
    // already on the note. The three branches differ ONLY in how the final
    // tag set is computed and when tags_updated_at is bumped:
    //
    //   - hasText && hasTags : final tags = union(explicit chips, inline).
    //                          tags_updated_at bumps UNCONDITIONALLY — the
    //                          client sent `tags`, so it opted in to a tag
    //                          write even if the set happens to match what's
    //                          already there (e.g. board reshuffle, user
    //                          re-confirming a chip selection).
    //   - hasText only       : final tags = union(EXISTING tags, inline).
    //                          tags_updated_at bumps ONLY when the set grew
    //                          (see `merged.length !== existingTags.length`
    //                          below) so a pure prose edit without new
    //                          `#tags` doesn't mark the tags as touched.
    //                          Originally specified in 2026-06-04-color-
    //                          regression.html D-003.
    //   - hasTags only       : pass-through; no text to parse, no strip.
    let inlineTags: string[] = [];
    if (hasText) {
      const raw = (body.text as string).slice(0, MAX_TEXT_LEN);
      const absorbed = absorbInlineHashtags(raw);
      patch.text = absorbed.text;
      patch.updatedAt = now;
      inlineTags = absorbed.tags;
    }
    if (hasTags) {
      const explicit = cleanTags(body.tags);
      const merged = hasText
        ? unionTagsOrdered(explicit, inlineTags).slice(0, MAX_TAGS_PER_NOTE)
        : explicit;
      patch.tags = JSON.stringify(merged);
      patch.tagsUpdatedAt = now;
    } else if (hasText) {
      const existingTags = safeParseTags(existing.tags);
      const merged = unionTagsOrdered(existingTags, inlineTags).slice(0, MAX_TAGS_PER_NOTE);
      if (merged.length !== existingTags.length) {
        patch.tags = JSON.stringify(merged);
        patch.tagsUpdatedAt = now;
      }
    }

    await d.update(schema.notes).set(patch).where(eq(schema.notes.uuid, uuid)).run();

    // Re-fetch joined with suggestion row so response matches GET /api/notes.
    const joined = await d
      .select({ note: schema.notes, sugg: schema.tagSuggestions })
      .from(schema.notes)
      .leftJoin(
        schema.tagSuggestions,
        and(
          eq(schema.tagSuggestions.uuid, schema.notes.uuid),
          isNull(schema.tagSuggestions.appliedAt),
          ne(schema.tagSuggestions.confidence, 'high'),
        ),
      )
      .where(eq(schema.notes.uuid, uuid))
      .get();
    if (!joined) return c.json({ error: 'note vanished after update' }, 500);
    return c.json({ note: toWire(joined) });
  } catch (err) {
    console.error('[notes] update failed', err);
    return c.json({ error: 'update failed', detail: String(err) }, 500);
  }
});

// --- Whiteboard position writes (2026-06-06; PLAN-whiteboard.md §4) ---
//
// Moves are NOT content edits: we never touch `updated_at` or
// `tags_updated_at`. That preserves the masonry/list reverse-chrono sort
// when the user reorganizes the whiteboard.
//
// Coordinates are clamped to ±1e6; non-finite (NaN, Infinity) is rejected.
// `z` is optional; absent means "don't change z_index".

/** Hard cap to keep one batch under D1 statement limits and avoid pathological
 *  AI-tool calls. 500 covers the current corpus (~2,500) in 5 round-trips. */
const MAX_POSITION_BATCH = 500;
const POSITION_COORD_LIMIT = 1_000_000;

function sanitizeCoord(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n > POSITION_COORD_LIMIT) return POSITION_COORD_LIMIT;
  if (n < -POSITION_COORD_LIMIT) return -POSITION_COORD_LIMIT;
  return n;
}

// PATCH /api/notes/:uuid/position  body { x, y, z? }
// Sets position_x / position_y (and optionally z_index). updated_at and
// tags_updated_at are NOT modified.
notesRoutes.patch('/:uuid/position', async (c) => {
  const uuid = c.req.param('uuid');
  if (!uuid) return c.json({ error: 'uuid required' }, 400);

  try {
    const body = (await c.req.json().catch(() => ({}))) as { x?: unknown; y?: unknown; z?: unknown };
    const x = sanitizeCoord(body.x);
    const y = sanitizeCoord(body.y);
    if (x === null || y === null) {
      return c.json({ error: 'x and y must be finite numbers' }, 400);
    }
    const patch: Partial<typeof schema.notes.$inferInsert> = { positionX: x, positionY: y };
    if (typeof body.z === 'number' && Number.isFinite(body.z)) {
      patch.zIndex = Math.trunc(body.z);
    }

    const d = db(c.env.DB);
    const existing = await d.select({ uuid: schema.notes.uuid })
      .from(schema.notes).where(eq(schema.notes.uuid, uuid)).get();
    if (!existing) return c.json({ error: 'note not found' }, 404);

    await d.update(schema.notes).set(patch).where(eq(schema.notes.uuid, uuid)).run();
    const after = await d.select().from(schema.notes).where(eq(schema.notes.uuid, uuid)).get();
    return c.json({ note: after });
  } catch (err) {
    console.error('[notes] position update failed', err);
    return c.json({ error: 'position update failed', detail: String(err) }, 500);
  }
});

// POST /api/notes/positions  body { updates: [{uuid, x, y, z?}, ...] }
// Atomic batch: each row updated under one D1 batch. Hard cap MAX_POSITION_BATCH.
// Unknown uuids are skipped (logged in the response count); the call still
// succeeds for the known ones — callers (multi-drag, AI arrange) want
// best-effort.
notesRoutes.post('/positions', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { updates?: unknown };
    if (!Array.isArray(body.updates)) {
      return c.json({ error: 'updates: array required' }, 400);
    }
    if (body.updates.length === 0) {
      return c.json({ ok: true, updated: 0 });
    }
    if (body.updates.length > MAX_POSITION_BATCH) {
      return c.json({ error: `too many updates (max ${MAX_POSITION_BATCH})` }, 400);
    }

    type Update = { uuid: string; x: number; y: number; z?: number };
    const sanitized: Update[] = [];
    for (const raw of body.updates) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as { uuid?: unknown; x?: unknown; y?: unknown; z?: unknown };
      if (typeof r.uuid !== 'string' || r.uuid.length === 0) continue;
      const x = sanitizeCoord(r.x);
      const y = sanitizeCoord(r.y);
      if (x === null || y === null) continue;
      const u: Update = { uuid: r.uuid, x, y };
      if (typeof r.z === 'number' && Number.isFinite(r.z)) u.z = Math.trunc(r.z);
      sanitized.push(u);
    }
    if (sanitized.length === 0) {
      return c.json({ ok: true, updated: 0 });
    }

    const d = db(c.env.DB);
    // Atomic batch — D1's `db.batch([...])` runs every statement inside one
    // implicit transaction. Either all succeed or D1 rolls the whole batch
    // back, satisfying the PLAN §4 invariant callers depend on for optimistic
    // rollback. drizzle-orm/d1 surfaces this as `db.batch(...)`.
    //
    // We pre-compose the statements (not promises) so drizzle's batch wraps
    // them as one round-trip — awaiting each .run() inline would defeat the
    // transactional grouping.
    const stmts = sanitized.map((u) => {
      const patch: Partial<typeof schema.notes.$inferInsert> = {
        positionX: u.x,
        positionY: u.y,
      };
      // The earlier sanitization pass already enforced integer-or-absent for z
      // (typeof check + Math.trunc) — here we just propagate whatever survived.
      if (u.z !== undefined) patch.zIndex = u.z;
      return d.update(schema.notes).set(patch).where(eq(schema.notes.uuid, u.uuid));
    });
    // drizzle's batch() typing wants a `[stmt, ...stmt[]]` non-empty tuple.
    // sanitized.length === 0 short-circuited above, so stmts is non-empty;
    // we cast in place instead of rebuilding the array.
    type BatchStmt = (typeof stmts)[number];
    await d.batch(stmts as [BatchStmt, ...BatchStmt[]]);
    return c.json({ ok: true, updated: sanitized.length });
  } catch (err) {
    console.error('[notes] batch position write failed', err);
    return c.json({ error: 'batch update failed', detail: String(err) }, 500);
  }
});

// POST /api/notes/:uuid/refresh-link — refetch source metadata/text.
notesRoutes.post('/:uuid/refresh-link', async (c) => {
  const uuid = c.req.param('uuid');
  if (!uuid) return c.json({ error: 'uuid required' }, 400);

  try {
    const d = db(c.env.DB);
    const existing = await d.select().from(schema.notes).where(eq(schema.notes.uuid, uuid)).get();
    if (!existing) return c.json({ error: 'note not found' }, 404);
    if (!existing.sourceUrl) return c.json({ error: 'note has no source url' }, 400);
    const patch = await refreshLinkNote(existing);
    await d.update(schema.notes).set({ ...patch, updatedAt: Date.now() }).where(eq(schema.notes.uuid, uuid)).run();
    const joined = await d
      .select({ note: schema.notes, sugg: schema.tagSuggestions })
      .from(schema.notes)
      .leftJoin(
        schema.tagSuggestions,
        and(
          eq(schema.tagSuggestions.uuid, schema.notes.uuid),
          isNull(schema.tagSuggestions.appliedAt),
          ne(schema.tagSuggestions.confidence, 'high'),
        ),
      )
      .where(eq(schema.notes.uuid, uuid))
      .get();
    if (!joined) return c.json({ error: 'note vanished after refresh' }, 500);
    return c.json({ note: toWire(joined) });
  } catch (err) {
    console.error('[notes] refresh-link failed', err);
    return c.json({ error: 'refresh-link failed', detail: String(err) }, 500);
  }
});

// DELETE /api/notes/:uuid — cascades tag_suggestions row via FK.
notesRoutes.delete('/:uuid', async (c) => {
  const uuid = c.req.param('uuid');
  if (!uuid) return c.json({ error: 'uuid required' }, 400);

  try {
    const d = db(c.env.DB);
    const existing = await d.select({ uuid: schema.notes.uuid })
      .from(schema.notes)
      .where(eq(schema.notes.uuid, uuid))
      .get();
    if (!existing) return c.json({ error: 'note not found' }, 404);
    await d.delete(schema.notes).where(eq(schema.notes.uuid, uuid)).run();
    return c.json({ ok: true });
  } catch (err) {
    console.error('[notes] delete failed', err);
    return c.json({ error: 'delete failed', detail: String(err) }, 500);
  }
});

// POST /api/notes/:uuid/accept-suggestion  body { tags? }
// Accepting ANY tag closes the suggestion row. Updates notes.tags +
// tags_updated_at; updated_at is NOT touched (a suggestion accept is a
// tag-only mutation under the new contract).
notesRoutes.post('/:uuid/accept-suggestion', async (c) => {
  const uuid = c.req.param('uuid');
  if (!uuid) return c.json({ error: 'uuid required' }, 400);

  try {
    const body = (await c.req.json().catch(() => ({}))) as { tags?: unknown };
    const requested: string[] | null = Array.isArray(body.tags)
      ? (body.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 0)
      : null;

    const d = db(c.env.DB);
    const noteRow = await d.select().from(schema.notes).where(eq(schema.notes.uuid, uuid)).get();
    if (!noteRow) return c.json({ error: 'note not found' }, 404);

    const suggRow = await d.select()
      .from(schema.tagSuggestions)
      .where(and(eq(schema.tagSuggestions.uuid, uuid), isNull(schema.tagSuggestions.appliedAt)))
      .get();
    if (!suggRow) return c.json({ note: noteRow });

    const pending: string[] = safeParseTags(suggRow.suggestedTags);
    const toAccept = requested ? requested.filter(t => pending.includes(t)) : pending;
    if (toAccept.length === 0) return c.json({ note: noteRow });

    const existingTags = safeParseTags(noteRow.tags);
    const merged = cleanTags(unionOrdered(existingTags, toAccept));
    const now = Date.now();

    await d.update(schema.notes)
      .set({ tags: JSON.stringify(merged), tagsUpdatedAt: now })
      .where(eq(schema.notes.uuid, uuid))
      .run();
    await d.update(schema.tagSuggestions)
      .set({ appliedAt: now })
      .where(eq(schema.tagSuggestions.uuid, uuid))
      .run();

    return c.json({
      note: { ...noteRow, tags: JSON.stringify(merged), tagsUpdatedAt: now },
    });
  } catch (err) {
    console.error('[notes] accept-suggestion failed', err);
    return c.json({ error: 'accept failed', detail: String(err) }, 500);
  }
});

// POST /api/notes/:uuid/reject-suggestion  body { tags? }
// notes.tags is NEVER modified by reject.
notesRoutes.post('/:uuid/reject-suggestion', async (c) => {
  const uuid = c.req.param('uuid');
  if (!uuid) return c.json({ error: 'uuid required' }, 400);

  try {
    const body = (await c.req.json().catch(() => ({}))) as { tags?: unknown };
    const requested: string[] | null = Array.isArray(body.tags)
      ? (body.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 0)
      : null;

    const d = db(c.env.DB);
    const noteRow = await d.select().from(schema.notes).where(eq(schema.notes.uuid, uuid)).get();
    if (!noteRow) return c.json({ error: 'note not found' }, 404);

    const suggRow = await d.select()
      .from(schema.tagSuggestions)
      .where(and(eq(schema.tagSuggestions.uuid, uuid), isNull(schema.tagSuggestions.appliedAt)))
      .get();
    if (!suggRow) return c.json({ note: noteRow });

    const pending: string[] = safeParseTags(suggRow.suggestedTags);
    const now = Date.now();

    if (!requested || requested.length === 0) {
      await d.update(schema.tagSuggestions)
        .set({ appliedAt: now })
        .where(eq(schema.tagSuggestions.uuid, uuid))
        .run();
      return c.json({ note: noteRow });
    }

    const remaining = pending.filter(t => !requested.includes(t));
    if (remaining.length === 0) {
      await d.update(schema.tagSuggestions)
        .set({ appliedAt: now })
        .where(eq(schema.tagSuggestions.uuid, uuid))
        .run();
    } else {
      const primaryTag = remaining.includes(suggRow.primaryTag) ? suggRow.primaryTag : remaining[0]!;
      await d.update(schema.tagSuggestions)
        .set({ suggestedTags: JSON.stringify(remaining), primaryTag })
        .where(eq(schema.tagSuggestions.uuid, uuid))
        .run();
    }
    return c.json({ note: noteRow });
  } catch (err) {
    console.error('[notes] reject-suggestion failed', err);
    return c.json({ error: 'reject failed', detail: String(err) }, 500);
  }
});

// --- Helpers ---

function safeParseTags(jsonStr: string | null | undefined): string[] {
  if (!jsonStr) return [];
  try {
    const v = JSON.parse(jsonStr);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function unionOrdered(a: string[], b: string[]): string[] {
  const seen = new Set(a);
  const out = [...a];
  for (const t of b) if (!seen.has(t)) { seen.add(t); out.push(t); }
  return out;
}

type JoinRow = {
  note: typeof schema.notes.$inferSelect;
  sugg: typeof schema.tagSuggestions.$inferSelect | null;
};
function toWire(row: JoinRow): Record<string, unknown> {
  const wire: Record<string, unknown> = { ...row.note };
  if (row.sugg && (row.sugg.confidence === 'medium' || row.sugg.confidence === 'low')) {
    const tags = safeParseTags(row.sugg.suggestedTags);
    if (tags.length > 0) {
      wire.pendingSuggestion = {
        tags,
        primary: row.sugg.primaryTag,
        confidence: row.sugg.confidence,
        rationale: row.sugg.rationale ?? '',
      };
    }
  }
  return wire;
}

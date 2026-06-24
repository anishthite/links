// Reload-persistence integration test for whiteboard positions.
//
// This is the test PLAN-whiteboard.md §9 lists as a 100% correctness gate
// ("dragging a note + full page reload restores its position"). We can't
// run Playwright headlessly inside vitest without bringing in a browser, so
// we simulate the equivalent contract at the API surface: the test creates
// notes, writes positions via single PATCH and batch POST, then re-reads
// the corpus through GET /api/notes and asserts the positions came back.
//
// The Hono app is the real one — no route mocking. The only swap is the D1
// binding: we hand it a `node:sqlite`-backed shim (tests/helpers/d1-shim.ts).
// This means the SQL drizzle generates, the route validation, the atomic
// batch path, and the to-wire shape all run for real.

import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';

import { app } from '../server/index';
import { freshShimDb } from './helpers/d1-shim';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATIONS = [
  path.join(MIGRATIONS_DIR, '0001_initial.sql'),
  path.join(MIGRATIONS_DIR, '0002_tag_suggestions.sql'),
  path.join(MIGRATIONS_DIR, '0003_tags_standalone.sql'),
  path.join(MIGRATIONS_DIR, '0004_ai_arrange_log.sql'),
  path.join(MIGRATIONS_DIR, '0011_links_metadata.sql'),
];

type Env = { DB: D1Database };

async function call(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return await app.fetch(new Request(`http://test.local${path}`, init), env);
}

let env: Env;

beforeEach(() => {
  env = { DB: freshShimDb(MIGRATIONS) };
});

describe('whiteboard position persistence', () => {
  it('POST /api/notes returns a note with position_x/y === null on first create', async () => {
    const res = await call(env, 'POST', '/api/notes', { text: 'hello' });
    expect(res.status).toBe(201);
    const body = await res.json() as { note: { uuid: string; positionX: number | null; positionY: number | null } };
    expect(body.note.positionX).toBeNull();
    expect(body.note.positionY).toBeNull();
    expect(typeof body.note.uuid).toBe('string');
  });

  it('PATCH /api/notes/:uuid/position persists across a fresh GET (reload simulation)', async () => {
    const create = await call(env, 'POST', '/api/notes', { text: 'movable' });
    const { note } = await create.json() as { note: { uuid: string; updatedAt: number; tagsUpdatedAt: number | null } };

    const beforeUpdatedAt = note.updatedAt;
    const beforeTagsAt = note.tagsUpdatedAt;

    const patch = await call(env, 'PATCH', `/api/notes/${note.uuid}/position`, { x: 123.5, y: -42 });
    expect(patch.status).toBe(200);

    // Reload-equivalent: full GET /api/notes returns the persisted row.
    const list = await call(env, 'GET', '/api/notes');
    expect(list.status).toBe(200);
    const body = await list.json() as { notes: Array<{ uuid: string; positionX: number; positionY: number; updatedAt: number; tagsUpdatedAt: number | null }> };
    const found = body.notes.find((n) => n.uuid === note.uuid);
    expect(found).toBeDefined();
    expect(found!.positionX).toBe(123.5);
    expect(found!.positionY).toBe(-42);
    // PLAN §4 contract: position writes MUST NOT touch updated_at or tags_updated_at.
    expect(found!.updatedAt).toBe(beforeUpdatedAt);
    expect(found!.tagsUpdatedAt).toBe(beforeTagsAt);
  });

  it('PATCH /api/notes/:uuid with tags only keeps updated_at unchanged', async () => {
    const create = await call(env, 'POST', '/api/notes', { text: 'tag me', tags: ['old'] });
    const { note } = await create.json() as { note: { uuid: string; updatedAt: number; tagsUpdatedAt: number | null } };

    const beforeUpdatedAt = note.updatedAt;
    const beforeTagsAt = note.tagsUpdatedAt;

    const patch = await call(env, 'PATCH', `/api/notes/${note.uuid}`, { tags: ['new'] });
    expect(patch.status).toBe(200);
    const patchBody = await patch.json() as { note: { updatedAt: number; tagsUpdatedAt: number | null; tags: string } };
    expect(patchBody.note.updatedAt).toBe(beforeUpdatedAt);
    expect(patchBody.note.tagsUpdatedAt).not.toBe(beforeTagsAt);
    expect(JSON.parse(patchBody.note.tags)).toEqual(['new']);
  });

  it('POST /api/notes/positions persists every entry in one atomic batch', async () => {
    const uuids: string[] = [];
    const beforeUpdatedAt = new Map<string, number>();
    const beforeTagsAt = new Map<string, number | null>();
    for (let i = 0; i < 5; i++) {
      const r = await call(env, 'POST', '/api/notes', { text: `n${i}` });
      const { note } = await r.json() as { note: { uuid: string; updatedAt: number; tagsUpdatedAt: number | null } };
      uuids.push(note.uuid);
      beforeUpdatedAt.set(note.uuid, note.updatedAt);
      beforeTagsAt.set(note.uuid, note.tagsUpdatedAt);
    }

    const updates = uuids.map((uuid, i) => ({ uuid, x: i * 100, y: i * 50 }));
    const batchRes = await call(env, 'POST', '/api/notes/positions', { updates });
    expect(batchRes.status).toBe(200);
    const batchBody = await batchRes.json() as { ok: boolean; updated: number };
    expect(batchBody.ok).toBe(true);
    expect(batchBody.updated).toBe(5);

    const list = await call(env, 'GET', '/api/notes');
    const { notes } = await list.json() as { notes: Array<{ uuid: string; positionX: number; positionY: number; updatedAt: number; tagsUpdatedAt: number | null }> };
    for (let i = 0; i < uuids.length; i++) {
      const found = notes.find((n) => n.uuid === uuids[i]);
      expect(found, `missing uuid ${uuids[i]}`).toBeDefined();
      expect(found!.positionX).toBe(i * 100);
      expect(found!.positionY).toBe(i * 50);
      // PLAN §4 contract: the BATCH position path must NOT bump updated_at or
      // tags_updated_at either — same invariant as the single-PATCH path.
      // (Review-finding fix: previously only the single-PATCH test asserted
      // this; AI-arrange and multi-drag both go through the batch path.)
      expect(found!.updatedAt).toBe(beforeUpdatedAt.get(uuids[i]!));
      expect(found!.tagsUpdatedAt).toBe(beforeTagsAt.get(uuids[i]!));
    }
  });

  it('PATCH /api/notes/:uuid/position rejects non-finite coordinates', async () => {
    const create = await call(env, 'POST', '/api/notes', { text: 'guarded' });
    const { note } = await create.json() as { note: { uuid: string } };
    const bad = await call(env, 'PATCH', `/api/notes/${note.uuid}/position`, { x: 'not a number', y: 0 });
    expect(bad.status).toBe(400);
    const nan = await call(env, 'PATCH', `/api/notes/${note.uuid}/position`, { x: 0, y: NaN });
    // JSON.stringify turns NaN into null, so this lands as a missing-y rejection.
    expect(nan.status).toBe(400);
    const inf = await call(env, 'PATCH', `/api/notes/${note.uuid}/position`, { x: 0, y: Infinity });
    expect(inf.status).toBe(400);
  });

  it('PATCH /api/notes/:uuid/position clamps magnitudes > 1e6', async () => {
    const create = await call(env, 'POST', '/api/notes', { text: 'clamped' });
    const { note } = await create.json() as { note: { uuid: string } };
    const patch = await call(env, 'PATCH', `/api/notes/${note.uuid}/position`, { x: 5e9, y: -5e9 });
    expect(patch.status).toBe(200);
    const list = await call(env, 'GET', '/api/notes');
    const { notes } = await list.json() as { notes: Array<{ uuid: string; positionX: number; positionY: number }> };
    const found = notes.find((n) => n.uuid === note.uuid);
    expect(found!.positionX).toBe(1_000_000);
    expect(found!.positionY).toBe(-1_000_000);
  });

  it('POST /api/notes/positions hard-caps the batch at MAX_POSITION_BATCH', async () => {
    // We don't have to create 501 notes — the cap rejects on payload length
    // before touching the database. Synthesizing uuids is fine for this gate.
    const updates = Array.from({ length: 501 }, (_, i) => ({ uuid: `fake-${i}`, x: 0, y: 0 }));
    const res = await call(env, 'POST', '/api/notes/positions', { updates });
    expect(res.status).toBe(400);
  });

  it('POST /api/ai/arrange whitelist-filters uuids before returning', async () => {
    // Create two notes; ask the AI to grid-arrange. All returned uuids must
    // exist in the corpus (regression guard against a hypothetical LLM
    // hallucination path that the deterministic parser doesn't take today
    // but the whitelist filter must still cover).
    const a = await call(env, 'POST', '/api/notes', { text: 'a' });
    const b = await call(env, 'POST', '/api/notes', { text: 'b' });
    const aUuid = (await a.json() as { note: { uuid: string } }).note.uuid;
    const bUuid = (await b.json() as { note: { uuid: string } }).note.uuid;

    const res = await call(env, 'POST', '/api/ai/arrange', { prompt: 'arrange in a grid' });
    expect(res.status).toBe(200);
    const body = await res.json() as { updates: Array<{ uuid: string; x: number; y: number }>; explanation: string };
    const known = new Set([aUuid, bUuid]);
    for (const u of body.updates) {
      expect(known.has(u.uuid), `unknown uuid ${u.uuid} leaked from /ai/arrange`).toBe(true);
    }
  });

  it('POST /api/ai/arrange writes a row to ai_arrange_log', async () => {
    // Create one note so the strategy has something to do.
    await call(env, 'POST', '/api/notes', { text: 'one' });
    const res = await call(env, 'POST', '/api/ai/arrange', { prompt: 'cluster by tag' });
    expect(res.status).toBe(200);

    // The route logs fire-and-forget; give microtasks a tick to flush.
    await new Promise<void>((r) => setImmediate(r));

    const stmt = env.DB.prepare('SELECT prompt, strategy, status, updates_count FROM ai_arrange_log ORDER BY id DESC LIMIT 1');
    const row = await stmt.first<{ prompt: string; strategy: string; status: string; updates_count: number }>();
    expect(row).not.toBeNull();
    expect(row!.prompt).toBe('cluster by tag');
    expect(row!.strategy).toBe('cluster-by-tag');
    expect(row!.status).toBe('ok');
    expect(row!.updates_count).toBeGreaterThan(0);
  });
});

import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { app } from '../server/index';
import { freshShimDb } from './helpers/d1-shim';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATIONS = [
  path.join(MIGRATIONS_DIR, '0001_initial.sql'),
  path.join(MIGRATIONS_DIR, '0002_tag_suggestions.sql'),
  path.join(MIGRATIONS_DIR, '0003_tags_standalone.sql'),
  path.join(MIGRATIONS_DIR, '0004_ai_arrange_log.sql'),
  path.join(MIGRATIONS_DIR, '0011_links_metadata.sql'),
  path.join(MIGRATIONS_DIR, '0012_source_chunks.sql'),
];

type Env = { DB: D1Database };

async function call(env: Env, method: string, pathname: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return await app.fetch(new Request(`http://test.local${pathname}`, init), env);
}

let env: Env;

beforeEach(() => {
  env = { DB: freshShimDb(MIGRATIONS) };
});

describe('link create dedupe', () => {
  it('returns the existing note for a normalized duplicate sourceUrl', async () => {
    const first = await call(env, 'POST', '/api/notes', {
      sourceUrl: 'https://Example.com/post?utm_source=test&b=2&a=1#intro',
      text: 'first note',
      tags: ['saved'],
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { note: { uuid: string; text: string; tags: string; sourceUrlNormalized: string } };

    const duplicate = await call(env, 'POST', '/api/notes', {
      sourceUrl: 'https://example.com/post?a=1&b=2&utm_medium=email#later',
      text: 'second note',
      tags: ['new'],
    });
    expect(duplicate.status).toBe(200);
    const duplicateBody = await duplicate.json() as { duplicate: true; note: { uuid: string; text: string; tags: string; sourceUrlNormalized: string } };
    expect(duplicateBody.duplicate).toBe(true);
    expect(duplicateBody.note.uuid).toBe(firstBody.note.uuid);
    expect(duplicateBody.note.sourceUrlNormalized).toBe('https://example.com/post?a=1&b=2');
    expect(duplicateBody.note.text).toBe('first note');
    expect(JSON.parse(duplicateBody.note.tags)).toEqual(['saved']);

    const list = await call(env, 'GET', '/api/notes');
    const listBody = await list.json() as { notes: Array<{ uuid: string }> };
    expect(listBody.notes).toHaveLength(1);
  });
});

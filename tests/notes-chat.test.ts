import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { app } from '../server/index';
import { NOTES_CHAT_SYSTEM_PROMPT } from '../server/routes/chat';
import { freshShimDb } from './helpers/d1-shim';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATIONS = [
  path.join(MIGRATIONS_DIR, '0001_initial.sql'),
  path.join(MIGRATIONS_DIR, '0002_tag_suggestions.sql'),
  path.join(MIGRATIONS_DIR, '0003_tags_standalone.sql'),
  path.join(MIGRATIONS_DIR, '0004_ai_arrange_log.sql'),
  path.join(MIGRATIONS_DIR, '0005_agent_sessions.sql'),
  path.join(MIGRATIONS_DIR, '0011_links_metadata.sql'),
  path.join(MIGRATIONS_DIR, '0012_source_chunks.sql'),
];

type Env = { DB: D1Database };

async function call(env: Env, method: string, reqPath: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.fetch(new Request(`http://test.local${reqPath}`, init), env);
}

async function seed(env: Env, text: string, tags: string[] = []): Promise<void> {
  const res = await call(env, 'POST', '/api/notes', { text, tags });
  expect(res.status).toBe(201);
}

async function seedLinkExtract(env: Env, sourceContentText: string): Promise<void> {
  const now = 1782198326912;
  await env.DB.prepare([
    'INSERT INTO notes (',
    'uuid, text, tags, z_index, created_at, updated_at, tags_updated_at,',
    'source_url, source_url_normalized, source_title, source_description, source_site_name,',
    'source_content_text, source_status',
    ') VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ].join(' ')).bind(
    'long-link-1',
    'Long retrieval article',
    JSON.stringify(['research']),
    now,
    now,
    now,
    'https://example.com/long-retrieval',
    'https://example.com/long-retrieval',
    'Long retrieval article',
    'A long article with the useful evidence near the end.',
    'Example',
    sourceContentText,
    'ready',
  ).run();
}

async function seedLinkChunk(env: Env, preview: string, chunk: string): Promise<void> {
  const now = 1782198326912;
  await seedLinkExtract(env, preview);
  await env.DB.prepare(`
    INSERT INTO note_source_chunks
      (note_uuid, chunk_index, heading, text, char_start, char_end, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind('long-link-1', 0, 'deep chunk', chunk, 40000, 40000 + chunk.length, now).run();
}

let env: Env;

beforeEach(() => {
  env = { DB: freshShimDb(MIGRATIONS) };
});

describe('notes chat routes', () => {
  it('keeps the LLM prompt fluid, generative, and discussive when evidence is thin', () => {
    expect(NOTES_CHAT_SYSTEM_PROMPT).toContain('thoughtful creative reasoning partner');
    expect(NOTES_CHAT_SYSTEM_PROMPT).toContain('multiple distinct angles, reframes, opposites, constraint flips, and adjacent ideas');
    expect(NOTES_CHAT_SYSTEM_PROMPT).toContain('shift naturally between generative and analytical thinking');
    expect(NOTES_CHAT_SYSTEM_PROMPT).toContain('ask 1-3 concrete follow-up questions');
    expect(NOTES_CHAT_SYSTEM_PROMPT).toContain('Do not end with "write a follow-up note"');
  });

  it('streams sources and answer text before the final answer', async () => {
    await seed(env, 'Buy coffee beans and filters', ['shopping']);
    await seed(env, 'Remember to renew passport next month', ['admin']);
    await seed(env, 'Coffee grinder settings for pourover: medium-coarse', ['coffee']);

    const res = await call(env, 'POST', '/api/chat/stream', { message: 'what do my notes say about coffee?' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"sources"');
    expect(text).toContain('coffee');
    expect(text).toContain('"type":"stdout"');
    expect(text.indexOf('"type":"stdout"')).toBeLessThan(text.indexOf('"type":"done"'));
    expect(text).toContain('"type":"done"');
  });

  it('uses the best long-source chunk as chat evidence', async () => {
    const early = 'front-loaded distractor '.repeat(90);
    const late = 'The useful needle retrieval passage says chunked evidence should be selected near the end.';
    await seedLinkExtract(env, `${early} ${late}`);

    const res = await call(env, 'POST', '/api/chat/stream', { message: 'needle retrieval evidence' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('needle retrieval passage says chunked evidence should be selected');
    expect(text).not.toContain('front-loaded distractor');
  });

  it('uses persisted source chunks beyond the note preview', async () => {
    await seedLinkChunk(
      env,
      'visible preview talks about unrelated coffee notes only',
      'Deep archived evidence says marmalade protocols need citrus zest and slow heat.',
    );

    const res = await call(env, 'POST', '/api/chat/stream', { message: 'marmalade protocols citrus' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('marmalade protocols need citrus zest and slow heat');
    expect(text).not.toContain('unrelated coffee notes only');
  });

  it('returns suggested questions', async () => {
    await seed(env, 'Coffee grinder settings for pourover: medium-coarse', ['coffee']);
    await seed(env, 'Draft questions for the AI journal buddy idea', ['idea', 'ai']);

    const res = await call(env, 'GET', '/api/chat/suggestions');
    expect(res.status).toBe(200);
    const body = await res.json() as { questions: string[] };
    expect(body.questions.length).toBeGreaterThan(0);
    expect(body.questions.length).toBeLessThanOrEqual(4);
    expect(body.questions.every((q) => q.endsWith('?'))).toBe(true);
  });

  it('returns follow-up suggestions from chat context', async () => {
    await seed(env, 'Coffee grinder settings for pourover: medium-coarse', ['coffee']);

    const res = await call(env, 'POST', '/api/chat/suggestions', {
      refresh: true,
      history: [{ role: 'user', content: 'what about coffee?' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { questions: string[] };
    expect(body.questions.length).toBeGreaterThan(0);
    expect(body.questions[0]).toContain('coffee');
  });

  it('save-note persists through the existing notes list', async () => {
    const save = await call(env, 'POST', '/api/chat/save-note', {
      text: 'Summarize the coffee experiments into a checklist',
      tags: ['coffee', 'summary'],
    });
    expect(save.status).toBe(201);

    const list = await call(env, 'GET', '/api/notes');
    const body = await list.json() as { notes: Array<{ text: string; tags: string }> };
    const found = body.notes.find((n) => n.text.includes('coffee experiments'));
    expect(found).toBeDefined();
    expect(found!.tags).toContain('coffee');
    expect(found!.tags).toContain('summary');
  });

  it('save-note reuses the normal note-write semantics for inline hashtags', async () => {
    const save = await call(env, 'POST', '/api/chat/save-note', {
      text: 'shower thought #idea',
      tags: ['thinking'],
    });
    expect(save.status).toBe(201);

    const body = await save.json() as { note: { text: string; tags: string } };
    expect(body.note.text).toBe('shower thought');
    expect(body.note.tags).toBe(JSON.stringify(['thinking', 'idea']));
  });
});

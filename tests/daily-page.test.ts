import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { maybeHandleDailyPageRequest, runDailyPageJob } from '../server/lib/daily-page';
import { freshShimDb } from './helpers/d1-shim';

type Env = {
  DB: D1Database;
  DAILY_PAGE_TIMEZONE?: string;
};

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATIONS = [
  path.join(MIGRATIONS_DIR, '0001_initial.sql'),
  path.join(MIGRATIONS_DIR, '0002_tag_suggestions.sql'),
  path.join(MIGRATIONS_DIR, '0003_tags_standalone.sql'),
  path.join(MIGRATIONS_DIR, '0009_daily_pages.sql'),
  path.join(MIGRATIONS_DIR, '0011_links_metadata.sql'),
  path.join(MIGRATIONS_DIR, '0012_source_chunks.sql'),
];

let env: Env;

beforeEach(() => {
  vi.useFakeTimers();
  env = { DB: freshShimDb(MIGRATIONS), DAILY_PAGE_TIMEZONE: 'America/Los_Angeles' };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('daily page generator', () => {
  it('generates exactly one page when the hourly cron crosses 7am local', async () => {
    await seedNote('fresh-1', 'Build the tiny voice memo idea', ['idea', 'ai'], '2026-06-19T22:00:00Z');
    await seedNote('fresh-2', 'UI polish for the board search', ['design'], '2026-06-19T23:00:00Z');
    await seedNote('old-1', 'Revisit ambient computing notes', ['idea', 'hardware'], '2026-04-01T12:00:00Z');

    vi.setSystemTime(new Date('2026-06-20T13:00:00Z'));
    await runDailyPageJob(env as never, Date.now());
    expect(await pageCount()).toBe(0);

    vi.setSystemTime(new Date('2026-06-20T14:00:00Z'));
    await runDailyPageJob(env as never, Date.now());
    expect(await pageCount()).toBe(1);

    await runDailyPageJob(env as never, Date.now());
    expect(await pageCount()).toBe(1);

    const row = await env.DB.prepare('SELECT local_date, title FROM daily_pages').first<{ local_date: string; title: string }>();
    expect(row?.local_date).toBe('2026-06-20');
    expect(row?.title).toContain('Brief');
  });

  it('serves /daily and generates on demand when today is missing', async () => {
    await seedNote('fresh-1', 'Prototype the daily briefing page', ['idea', 'writing'], '2026-06-20T01:00:00Z');
    await seedNote('fresh-2', 'Collect the best old notes to resurface', ['idea'], '2026-06-18T20:00:00Z');
    await seedNote('old-1', 'Make software feel more alive', ['design'], '2026-03-01T18:00:00Z');

    vi.setSystemTime(new Date('2026-06-20T16:30:00Z'));
    const res = await maybeHandleDailyPageRequest(new Request('http://test.local/daily'), env as never);

    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain('Board daily');
    expect(html).toContain('Prototype the daily briefing page');
    expect(html).toContain('Question to chase');
    expect(html).toContain('Worth revisiting');
    expect(await pageCount()).toBe(1);

    const dated = await maybeHandleDailyPageRequest(new Request('http://test.local/daily/2026-06-20'), env as never);
    expect(dated?.status).toBe(200);
    expect(await dated!.text()).toContain('2026-06-20');
  });

  it('does not feature junk numeric scraps as resurfaced notes', async () => {
    await seedNote('fresh-1', 'Ship the agent setup cleanup', ['agent'], '2026-06-20T01:00:00Z');
    await seedNote('junk-1', '2039200063', [], '2012-02-01T18:00:00Z');
    await seedNote('junk-2', 'H', [], '2012-03-01T18:00:00Z');
    await seedNote('real-1', 'Revisit the ambient robotics sketch', ['robotics', 'idea'], '2026-02-01T18:00:00Z');

    vi.setSystemTime(new Date('2026-06-20T16:30:00Z'));
    const res = await maybeHandleDailyPageRequest(new Request('http://test.local/daily'), env as never);
    const html = await res!.text();

    expect(html).toContain('Revisit the ambient robotics sketch');
    expect(html).not.toContain('2039200063');
    expect(html).not.toContain('<h3>H</h3>');
  });
});

async function pageCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM daily_pages').first<number>('count');
  return Number(row || 0);
}

async function seedNote(uuid: string, text: string, tags: string[], iso: string): Promise<void> {
  const ms = Date.parse(iso);
  await env.DB.prepare('INSERT INTO notes (uuid, text, tags, z_index, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .bind(uuid, text, JSON.stringify(tags), ms, ms)
    .run();
}

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runAutoTagger } from '../server/lib/auto-tag';
import { heuristicLinkTagPrediction } from '../server/lib/link-tag-service';
import { freshShimDb } from './helpers/d1-shim';

type Env = {
  DB: D1Database;
  TAGGER_MODEL_ID?: string;
  AUTO_TAG_LIMIT?: string;
};

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATIONS = [
  path.join(MIGRATIONS_DIR, '0001_initial.sql'),
  path.join(MIGRATIONS_DIR, '0002_tag_suggestions.sql'),
  path.join(MIGRATIONS_DIR, '0003_tags_standalone.sql'),
  path.join(MIGRATIONS_DIR, '0011_links_metadata.sql'),
  path.join(MIGRATIONS_DIR, '0012_source_chunks.sql'),
];

describe('link tag service', () => {
  it('classifies coding-agent setup links by topic, not source type', () => {
    const prediction = heuristicLinkTagPrediction({
      uuid: 'n1',
      text: 'How to Setup a Local Coding Agent on macOS',
      sourceUrl: 'https://ikyle.me/blog/2026/how-to-setup-a-local-coding-agent-on-macos',
      sourceTitle: 'How to Setup a Local Coding Agent on macOS',
      sourceDescription: 'Practical setup guide for a local coding agent harness on macOS.',
      sourceSiteName: 'Kyle Howells',
      sourceContentText: 'local coding agent harness setup guide with tools and workflows',
    });

    expect(prediction.tags).toEqual(['tools', 'agents']);
    expect(prediction.confidence).toBe('high');
    expect(prediction.tags).not.toContain('link' as never);
    expect(prediction.tags.length).toBeLessThanOrEqual(2);
  });

  it('separates focus from psychology for self-improvement links', () => {
    const prediction = heuristicLinkTagPrediction({
      uuid: 'n2',
      text: 'How to become someone new without faking it',
      sourceUrl: 'https://x.com/Electrarythm/status/2066126688732266711',
      sourceTitle: 'How to become someone new (without faking it)',
      sourceDescription: 'On self-image, identity, and changing your behavior.',
      sourceSiteName: 'X',
      sourceContentText: 'self-image identity behavior mindset confidence and focus',
    });

    expect(prediction.tags).toEqual(['focus', 'psychology']);
  });

  it('applies auto-tags directly instead of storing suggestions', async () => {
    const env: Env = { DB: freshShimDb(MIGRATIONS), AUTO_TAG_LIMIT: '10' };
    const now = 1_719_000_000_000;

    await seedLink(env.DB, {
      uuid: 'high-1',
      text: 'How to Setup a Local Coding Agent on macOS',
      sourceUrl: 'https://ikyle.me/blog/2026/how-to-setup-a-local-coding-agent-on-macos',
      sourceTitle: 'How to Setup a Local Coding Agent on macOS',
      sourceDescription: 'Practical setup guide for a local coding agent harness on macOS.',
      sourceContentText: 'local coding agent harness setup guide with tools and workflows',
      createdAt: now,
    });
    await seedLink(env.DB, {
      uuid: 'med-1',
      text: 'A Letter to My Younger Self',
      sourceUrl: 'https://x.com/pk_iv/status/2066272106682466799',
      sourceTitle: 'A Letter to My Younger Self',
      sourceDescription: 'Career advice and reflections for your younger self.',
      sourceContentText: 'career advice mentorship and professional growth',
      createdAt: now + 1,
    });
    await env.DB.prepare('INSERT INTO notes (uuid, text, tags, z_index, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .bind('plain-1', 'just a local note', '[]', now + 2, now + 2)
      .run();

    const result = await runAutoTagger(env as never);

    expect(result.reason).toBe('heuristic fallback');
    expect(result.tagged).toBe(2);
    expect(result.suggested).toBe(0);

    const high = await env.DB.prepare('SELECT tags FROM notes WHERE uuid = ?').bind('high-1').first<{ tags: string }>();
    expect(high?.tags).toBe('["tools","agents"]');

    const medium = await env.DB.prepare('SELECT tags FROM notes WHERE uuid = ?').bind('med-1').first<{ tags: string }>();
    expect(medium?.tags).toBe('["career"]');

    const suggestions = await env.DB.prepare('SELECT COUNT(*) AS count FROM tag_suggestions').first<{ count: number }>();
    expect(Number(suggestions?.count || 0)).toBe(0);
  });

  it('converts stale pending suggestions into real tags when sweeping', async () => {
    const env: Env = { DB: freshShimDb(MIGRATIONS), AUTO_TAG_LIMIT: '1' };
    const now = 1_719_000_000_000;

    await seedLink(env.DB, {
      uuid: 'pending-old',
      text: 'A Letter to My Younger Self',
      sourceUrl: 'https://x.com/pk_iv/status/2066272106682466799',
      sourceTitle: 'A Letter to My Younger Self',
      sourceDescription: 'Career advice and reflections for your younger self.',
      sourceContentText: 'career advice mentorship and professional growth',
      createdAt: now,
    });
    await env.DB.prepare('INSERT INTO tag_suggestions (uuid, suggested_tags, primary_tag, confidence, rationale, applied_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .bind('pending-old', '["career"]', 'career', 'medium', 'seeded pending', now)
      .run();
    await seedLink(env.DB, {
      uuid: 'fresh-next',
      text: 'How to Setup a Local Coding Agent on macOS',
      sourceUrl: 'https://ikyle.me/blog/2026/how-to-setup-a-local-coding-agent-on-macos',
      sourceTitle: 'How to Setup a Local Coding Agent on macOS',
      sourceDescription: 'Practical setup guide for a local coding agent harness on macOS.',
      sourceContentText: 'local coding agent harness setup guide with tools and workflows',
      createdAt: now + 1,
    });

    const first = await runAutoTagger(env as never);

    expect(first.considered).toBe(1);
    expect(first.tagged).toBe(1);
    const old = await env.DB.prepare('SELECT tags FROM notes WHERE uuid = ?').bind('pending-old').first<{ tags: string }>();
    expect(old?.tags).toBe('["career"]');
    const cleared = await env.DB.prepare('SELECT applied_at FROM tag_suggestions WHERE uuid = ?').bind('pending-old').first<{ applied_at: number | null }>();
    expect(cleared?.applied_at).not.toBeNull();

    const second = await runAutoTagger(env as never);

    expect(second.considered).toBe(1);
    const fresh = await env.DB.prepare('SELECT tags FROM notes WHERE uuid = ?').bind('fresh-next').first<{ tags: string }>();
    expect(fresh?.tags).toBe('["tools","agents"]');
  });
});

async function seedLink(db: D1Database, row: {
  uuid: string;
  text: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceDescription: string;
  sourceContentText: string;
  createdAt: number;
}): Promise<void> {
  await db.prepare([
    'INSERT INTO notes (',
    'uuid, text, tags, z_index, created_at, updated_at, tags_updated_at,',
    'source_url, source_url_normalized, source_title, source_description, source_site_name,',
    'source_fetched_at, source_content_text, source_content_markdown, source_status, source_last_error',
    ') VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ].join(' '))
    .bind(
      row.uuid,
      row.text,
      '[]',
      row.createdAt,
      row.createdAt,
      row.createdAt,
      row.sourceUrl,
      row.sourceUrl,
      row.sourceTitle,
      row.sourceDescription,
      'example.com',
      row.createdAt,
      row.sourceContentText,
      row.sourceContentText,
      'ready',
      '',
    )
    .run();
}

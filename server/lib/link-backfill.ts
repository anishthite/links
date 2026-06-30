import { eq } from 'drizzle-orm';

import type { Env } from '../env';
import { db, schema } from '../../db/client';
import { buildSourceChunks, refreshLinkNote, replaceLinkSourceChunks } from './link-source';

export type LinkScrapeBackfillResult = {
  considered: number;
  refreshed: number;
  failed: number;
  skipped: number;
  limit: number;
  uuids: string[];
  reason?: string;
};

type BackfillRow = {
  uuid: string;
  text: string;
  source_url: string;
  source_title: string | null;
  source_description: string | null;
  source_status: string | null;
  source_content_text: string | null;
  has_chunks: number;
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
const PENDING_GRACE_MS = 5 * 60 * 1000;
const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;

export async function runLinkScrapeBackfill(env: Env, opts: { limit?: unknown; now?: number } = {}): Promise<LinkScrapeBackfillResult> {
  const limit = clampLimit(opts.limit ?? env.LINK_BACKFILL_LIMIT);
  if (limit === 0) {
    return { considered: 0, refreshed: 0, failed: 0, skipped: 0, limit, uuids: [], reason: 'disabled' };
  }

  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const rows = await selectBackfillCandidates(env.DB, limit, now);
  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  const uuids: string[] = [];

  for (const row of rows) {
    try {
      if (row.source_status === 'ready' && row.source_content_text?.trim() && Number(row.has_chunks) === 0) {
        await replaceLinkSourceChunks(env.DB, row.uuid, buildSourceChunks(row.source_content_text, now));
        uuids.push(row.uuid);
        refreshed += 1;
        continue;
      }
      const { notePatch, chunks } = await refreshLinkNote({
        sourceUrl: row.source_url,
        text: row.text,
        sourceTitle: row.source_title,
        sourceDescription: row.source_description,
      }, env);
      await db(env.DB).update(schema.notes)
        .set({ ...notePatch, updatedAt: Date.now() })
        .where(eq(schema.notes.uuid, row.uuid))
        .run();
      await replaceLinkSourceChunks(env.DB, row.uuid, chunks);
      uuids.push(row.uuid);
      if (notePatch.sourceStatus === 'ready') refreshed += 1;
      else failed += 1;
    } catch (err) {
      console.error('[link-backfill] refresh failed', row.uuid, err);
      failed += 1;
    }
  }

  skipped = Math.max(0, rows.length - refreshed - failed);
  return { considered: rows.length, refreshed, failed, skipped, limit, uuids };
}

async function selectBackfillCandidates(d1: D1Database, limit: number, now: number): Promise<BackfillRow[]> {
  const pendingBefore = now - PENDING_GRACE_MS;
  const retryBefore = now - FAILED_RETRY_MS;
  const result = await d1.prepare(`
    SELECT
      uuid,
      text,
      source_url,
      source_title,
      source_description,
      source_status,
      source_content_text,
      EXISTS (
        SELECT 1 FROM note_source_chunks c WHERE c.note_uuid = notes.uuid
      ) AS has_chunks
    FROM notes
    WHERE source_url IS NOT NULL
      AND trim(source_url) <> ''
      AND (
        source_status IS NULL
        OR source_status NOT IN ('pending', 'ready', 'failed')
        OR (source_status = 'pending' AND created_at < ?)
        OR (source_status = 'failed' AND (source_fetched_at IS NULL OR source_fetched_at < ?))
        OR (
          source_status = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM note_source_chunks c WHERE c.note_uuid = notes.uuid
          )
          AND source_content_text IS NOT NULL
          AND trim(source_content_text) <> ''
        )
        OR (
          source_status = 'ready'
          AND (
            source_fetched_at IS NULL
            OR source_fetched_at < ?
            OR source_extractor IS NULL
            OR trim(source_extractor) = ''
          )
          AND (
            source_content_text IS NULL
            OR trim(source_content_text) = ''
            OR source_extractor IS NULL
            OR trim(source_extractor) = ''
            OR source_content_length IS NULL
            OR source_content_length = 0
            OR NOT EXISTS (
              SELECT 1 FROM note_source_chunks c WHERE c.note_uuid = notes.uuid
            )
          )
        )
      )
    ORDER BY
      CASE
        WHEN source_status = 'pending' THEN 0
        WHEN source_status = 'ready' AND NOT EXISTS (
          SELECT 1 FROM note_source_chunks c WHERE c.note_uuid = notes.uuid
        ) THEN 1
        WHEN source_status IS NULL THEN 2
        WHEN source_status = 'failed' THEN 3
        ELSE 4
      END,
      COALESCE(source_fetched_at, 0) ASC,
      created_at ASC
    LIMIT ?
  `).bind(pendingBefore, retryBefore, retryBefore, limit).all<BackfillRow>();
  return result.results || [];
}

function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  if (n <= 0) return 0;
  return Math.min(MAX_LIMIT, Math.trunc(n));
}

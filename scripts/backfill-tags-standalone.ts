#!/usr/bin/env tsx
// One-shot backfill for the standalone-tags redesign.
// See implementation-notes/2026-06-02-tags-standalone.html.
//
// Usage:
//   tsx scripts/backfill-tags-standalone.ts                # dry run (stdout SQL)
//   tsx scripts/backfill-tags-standalone.ts --apply        # apply locally via wrangler
//   tsx scripts/backfill-tags-standalone.ts --apply --remote
//
// For each row in `notes`:
//   - If tags JSON is already non-empty → skip (idempotent re-runs).
//   - Else: parse legacy `#hashtag` tokens out of text via parseHashtags(),
//     write that array into notes.tags, AND strip the first occurrence of
//     each derived hashtag from notes.text (D-003 / D-004). Other in-prose
//     mentions of the same hashtag are intentionally left alone.
//   - Set tags_updated_at = updated_at (matches the existing modification time).
//
// updated_at is NEVER bumped (this is a tag-only mutation under the new contract).

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseHashtags, stripFirstHashtagsForTags } from './lib/legacy-hashtag-parser';

const APPLY = process.argv.includes('--apply');
const REMOTE = process.argv.includes('--remote');
const TARGET = REMOTE ? '--remote' : '--local';

function sqlQuote(s: string): string { return "'" + s.replace(/'/g, "''") + "'"; }

type Row = { uuid: string; text: string; tags: string };

function fetchRows(): Row[] {
  const json = execSync(
    `wrangler d1 execute board-db ${TARGET} --json --command "SELECT uuid, text, tags FROM notes"`,
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(json) as Array<{ results: Row[] }>;
  return parsed[0]?.results ?? [];
}

function isAlreadyTagged(jsonStr: string): boolean {
  try {
    const v = JSON.parse(jsonStr);
    return Array.isArray(v) && v.length > 0;
  } catch { return false; }
}

function emitSql(rows: Row[]): { sql: string; touched: number; stripped: number } {
  const lines: string[] = [];
  lines.push(`-- Backfill: standalone tags. Generated ${new Date().toISOString()}.`);
  lines.push(`-- target=${TARGET}, rows scanned=${rows.length}`);
  let touched = 0;
  let stripped = 0;
  for (const r of rows) {
    if (isAlreadyTagged(r.tags)) continue;
    const tags = parseHashtags(r.text);
    if (tags.length === 0) {
      // Still bump tags_updated_at so we don't re-scan on future passes? No —
      // leave it NULL so a row with no tags-at-rest stays cheap to detect.
      continue;
    }
    const newText = stripFirstHashtagsForTags(r.text, tags);
    if (newText !== r.text) stripped++;
    lines.push(
      `UPDATE notes SET tags = ${sqlQuote(JSON.stringify(tags))}, ` +
      `text = ${sqlQuote(newText)}, ` +
      `tags_updated_at = updated_at ` +
      `WHERE uuid = ${sqlQuote(r.uuid)};`,
    );
    touched++;
  }
  return { sql: lines.join('\n') + '\n', touched, stripped };
}

const rows = fetchRows();
const { sql, touched, stripped } = emitSql(rows);

if (!APPLY) {
  process.stdout.write(sql);
  process.stderr.write(`[backfill] dry-run: would touch ${touched}/${rows.length} rows (${stripped} text-strips). Re-run with --apply.\n`);
  process.exit(0);
}

// Apply mode: snapshot first, then execute.
const backupsDir = resolve('db/backups');
if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });
const snap = resolve(backupsDir, `pre-tags-standalone-${Date.now()}.sql`);
process.stderr.write(`[backfill] snapshotting current rows → ${snap}\n`);
const snapLines: string[] = [
  '-- Pre-backfill snapshot. Restore with:',
  '--   wrangler d1 execute board-db ${TARGET} --file=<this-file>',
  '',
];
for (const r of rows) {
  snapLines.push(
    `UPDATE notes SET text = ${sqlQuote(r.text)}, tags = ${sqlQuote(r.tags)} WHERE uuid = ${sqlQuote(r.uuid)};`,
  );
}
writeFileSync(snap, snapLines.join('\n') + '\n');

const applyPath = resolve('db/seed.tags-standalone.sql');
writeFileSync(applyPath, sql);
process.stderr.write(`[backfill] applying ${touched} row updates via wrangler (${TARGET})…\n`);
execSync(
  `wrangler d1 execute board-db ${TARGET} --file=${applyPath}`,
  { stdio: 'inherit' },
);
process.stderr.write(`[backfill] done. touched=${touched}, stripped=${stripped}. snapshot=${snap}\n`);

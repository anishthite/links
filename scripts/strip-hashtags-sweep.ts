#!/usr/bin/env tsx
// One-shot sweep: for every note, remove the FIRST inline `#tag` occurrence
// for each tag that's already in notes.tags. Idempotent — re-running after a
// successful apply does nothing (no more matching #tag tokens remain).
//
// Companion to scripts/backfill-tags-standalone.ts. The backfill skipped rows
// whose tags column was already populated by the legacy server-side parser,
// which left hashtag tokens stranded in prose. This sweep cleans them up.
// See implementation-notes/2026-06-02-tags-standalone.html#D-003.
//
// Usage:
//   npx tsx scripts/strip-hashtags-sweep.ts                # dry-run (SQL to stdout)
//   npx tsx scripts/strip-hashtags-sweep.ts --apply
//   npx tsx scripts/strip-hashtags-sweep.ts --apply --remote
//
// updated_at is NEVER bumped (text changes here are metadata cleanup, not edits).
// tags_updated_at is left untouched too — the tag set didn't change.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { stripFirstHashtagsForTags } from './lib/legacy-hashtag-parser';

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

function parseTagsArr(jsonStr: string): string[] {
  try {
    const v = JSON.parse(jsonStr);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

const rows = fetchRows();
const lines: string[] = [];
lines.push(`-- Strip hashtags sweep. Generated ${new Date().toISOString()}.`);
lines.push(`-- target=${TARGET}, rows scanned=${rows.length}`);
let touched = 0;
const examples: Array<{ uuid: string; before: string; after: string }> = [];
for (const r of rows) {
  const tags = parseTagsArr(r.tags);
  if (tags.length === 0) continue;
  const next = stripFirstHashtagsForTags(r.text, tags);
  if (next === r.text) continue;
  lines.push(`UPDATE notes SET text = ${sqlQuote(next)} WHERE uuid = ${sqlQuote(r.uuid)};`);
  if (examples.length < 3) examples.push({ uuid: r.uuid, before: r.text, after: next });
  touched++;
}

if (!APPLY) {
  process.stdout.write(lines.join('\n') + '\n');
  process.stderr.write(`[sweep] dry-run: would touch ${touched}/${rows.length} rows.\n`);
  for (const ex of examples) {
    process.stderr.write(`  ─ ${ex.uuid}\n    before: ${JSON.stringify(ex.before.slice(0, 140))}\n    after : ${JSON.stringify(ex.after.slice(0, 140))}\n`);
  }
  process.stderr.write(`Re-run with --apply to commit.\n`);
  process.exit(0);
}

const backupsDir = resolve('db/backups');
if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });
const snap = resolve(backupsDir, `pre-strip-sweep-${Date.now()}.sql`);
process.stderr.write(`[sweep] snapshotting → ${snap}\n`);
const snapLines: string[] = ['-- Pre-strip-sweep snapshot. Restore with: wrangler d1 execute board-db <target> --file=<this>', ''];
for (const r of rows) snapLines.push(`UPDATE notes SET text = ${sqlQuote(r.text)} WHERE uuid = ${sqlQuote(r.uuid)};`);
writeFileSync(snap, snapLines.join('\n') + '\n');

const applyPath = resolve('db/seed.strip-sweep.sql');
writeFileSync(applyPath, lines.join('\n') + '\n');
process.stderr.write(`[sweep] applying ${touched} row updates via wrangler (${TARGET})…\n`);
execSync(`wrangler d1 execute board-db ${TARGET} --file=${applyPath}`, { stdio: 'inherit' });
process.stderr.write(`[sweep] done. touched=${touched}. snapshot=${snap}\n`);

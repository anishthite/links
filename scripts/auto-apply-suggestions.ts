#!/usr/bin/env tsx
// Bulk auto-apply tag suggestions into notes.tags. Generalized form of
// scripts/auto-apply-high-conf.ts — supports any subset of confidence levels.
//
// See implementation-notes/2026-06-01-accept-all-ghost-tags.html for the
// design decisions (D-001..D-006), tradeoffs, and reversibility plan.
//
// Strategy (identical to auto-apply-high-conf.ts):
//   For every tag_suggestions row matching the confidence filter AND
//   applied_at IS NULL, merge the full suggested_tags array into notes.tags
//   as the union (dedup'd, preserving existing tag order), then mark applied.
//
// Usage:
//   # default: ALL pending (high + medium + low), local DB
//   tsx scripts/auto-apply-suggestions.ts > db/seed.auto-apply-suggestions.sql
//   wrangler d1 execute board-db --local --file=db/seed.auto-apply-suggestions.sql
//
//   # remote prod backfill (the original ask):
//   tsx scripts/auto-apply-suggestions.ts --remote > db/seed.auto-apply-suggestions.sql
//   wrangler d1 execute board-db --remote --file=db/seed.auto-apply-suggestions.sql
//
//   # narrow to medium only:
//   tsx scripts/auto-apply-suggestions.ts --remote --confidence=medium > db/seed.auto-apply-suggestions.sql
//
//   # inspect mode: print aggregate diff to stderr, emit NO sql.
//   tsx scripts/auto-apply-suggestions.ts --remote --inspect
//
// Idempotent: re-running is a no-op because applied_at IS NOT NULL filters
// out already-applied rows.
//
// Safety: the script writes a JSON backup of every affected row's pre-apply
// notes.tags to db/backups/notes-tags-pre-bulk-accept-<timestamp>.json BEFORE
// emitting SQL. That's the only way to revert (see R-001 in the notes).
//
// D1 compatibility: emitted SQL deliberately omits BEGIN TRANSACTION/COMMIT;
// `wrangler d1 execute --file` auto-batches and rejects explicit transactions.

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Row = {
  uuid: string;
  note_tags: string;
  sugg_tags: string;
  confidence: string;
};
type WranglerResult = [{ success: boolean; results: Row[]; meta?: unknown }];

function sqlQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const useRemote = argv.includes('--remote');
const inspectOnly = argv.includes('--inspect');
const dbFlag = useRemote ? '--remote' : '--local';

// --confidence=high,medium,low  (default: all three)
const VALID_CONF = new Set(['high', 'medium', 'low']);
let confidences: string[] = ['high', 'medium', 'low'];
const confArg = argv.find((a) => a.startsWith('--confidence='));
if (confArg) {
  const raw = confArg.slice('--confidence='.length);
  confidences = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  for (const c of confidences) {
    if (!VALID_CONF.has(c)) {
      process.stderr.write(`✗ unknown --confidence value: ${c} (allowed: high, medium, low)\n`);
      process.exit(2);
    }
  }
}
const confSqlList = confidences.map((c) => `'${c}'`).join(', ');

// ---- query ----------------------------------------------------------------
process.stderr.write(`[apply-sugg] DB=${dbFlag}  confidence IN (${confidences.join(', ')})\n`);
const queryResult = execSync(
  `npx wrangler d1 execute board-db ${dbFlag} --json --command ` +
    `"SELECT n.uuid as uuid, n.tags as note_tags, ts.suggested_tags as sugg_tags, ts.confidence as confidence ` +
    `  FROM notes n ` +
    `  JOIN tag_suggestions ts ON ts.uuid = n.uuid ` +
    `  WHERE ts.confidence IN (${confSqlList}) AND ts.applied_at IS NULL"`,
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const parsed = JSON.parse(queryResult) as WranglerResult;
const rows = parsed[0]?.results ?? [];

if (rows.length === 0) {
  process.stderr.write(`[apply-sugg] 0 pending rows — nothing to do.\n`);
  process.exit(0);
}

// ---- backup BEFORE emitting any mutation SQL ------------------------------
// One-way to revert: see R-001 in the implementation notes.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const BACKUP_DIR = join(REPO, 'db', 'backups');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = join(BACKUP_DIR, `notes-tags-pre-bulk-accept-${dbFlag.slice(2)}-${ts}.json`);

if (!inspectOnly) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = rows.map((r) => ({
    uuid: r.uuid,
    tags_before: JSON.parse(r.note_tags || '[]'),
    confidence: r.confidence,
  }));
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  process.stderr.write(`[apply-sugg] backup written → ${backupPath}\n`);
}

// ---- merge + emit ---------------------------------------------------------
const now = Date.now();
let considered = 0;
let tagUpdates = 0;
let dedupSkips = 0;
let totalAdditions = 0;
const addedTagCounts = new Map<string, number>();
const perConfidence: Record<string, { rows: number; additions: number }> = {};

if (!inspectOnly) {
  process.stdout.write(`-- Generated by scripts/auto-apply-suggestions.ts on ${new Date().toISOString()}\n`);
  process.stdout.write(`-- Source DB: ${dbFlag}\n`);
  process.stdout.write(`-- Confidence filter: ${confidences.join(', ')}\n`);
  process.stdout.write(`-- Pending rows considered: ${rows.length}\n`);
  process.stdout.write(`-- Strategy: union notes.tags ∪ tag_suggestions.suggested_tags, dedup, write back.\n`);
  process.stdout.write(`-- Backup: ${backupPath}\n`);
  process.stdout.write(`-- No BEGIN/COMMIT: D1 wrangler batches the file and rejects explicit transactions.\n\n`);
}

for (const r of rows) {
  considered++;
  const existing: string[] = JSON.parse(r.note_tags || '[]');
  const suggested: string[] = JSON.parse(r.sugg_tags || '[]');

  const bucket = (perConfidence[r.confidence] ??= { rows: 0, additions: 0 });
  bucket.rows++;

  const seen = new Set(existing);
  const additions: string[] = [];
  for (const t of suggested) {
    if (!seen.has(t)) {
      seen.add(t);
      additions.push(t);
    }
  }

  if (additions.length === 0) {
    dedupSkips++;
  } else {
    const merged = [...existing, ...additions];
    totalAdditions += additions.length;
    bucket.additions += additions.length;
    tagUpdates++;
    for (const t of additions) {
      addedTagCounts.set(t, (addedTagCounts.get(t) ?? 0) + 1);
    }
    if (!inspectOnly) {
      process.stdout.write(
        `UPDATE notes SET tags = ${sqlQuote(JSON.stringify(merged))} ` +
          `WHERE uuid = ${sqlQuote(r.uuid)};\n`,
      );
    }
  }

  if (!inspectOnly) {
    // Always mark applied — dedup-skips count as "user has accepted".
    process.stdout.write(
      `UPDATE tag_suggestions SET applied_at = ${now} ` + `WHERE uuid = ${sqlQuote(r.uuid)};\n`,
    );
  }
}

// ---- summary --------------------------------------------------------------
process.stderr.write(`\n[apply-sugg] ===== summary =====\n`);
process.stderr.write(`[apply-sugg] source DB     : ${dbFlag}\n`);
process.stderr.write(`[apply-sugg] confidence    : ${confidences.join(', ')}\n`);
process.stderr.write(`[apply-sugg] considered    : ${considered} pending rows\n`);
process.stderr.write(`[apply-sugg] tag-updates   : ${tagUpdates} notes.tags rows modified\n`);
process.stderr.write(`[apply-sugg] dedup-skips   : ${dedupSkips} suggestions already covered\n`);
process.stderr.write(`[apply-sugg] additions     : ${totalAdditions} individual tags added\n`);
for (const [c, b] of Object.entries(perConfidence)) {
  process.stderr.write(`[apply-sugg]   ${c.padEnd(7)}: ${b.rows} rows / ${b.additions} additions\n`);
}
const topTags = [...addedTagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
process.stderr.write(`[apply-sugg] top added tags:\n`);
for (const [t, n] of topTags) {
  process.stderr.write(`[apply-sugg]   ${t.padEnd(20)} ${n}\n`);
}
if (!inspectOnly) {
  process.stderr.write(`[apply-sugg] all ${considered} suggestions marked applied_at=${now}\n`);
  process.stderr.write(`[apply-sugg] next step: wrangler d1 execute board-db ${dbFlag} --file=<your seed path>\n`);
} else {
  process.stderr.write(`[apply-sugg] --inspect: no SQL emitted, no backup written.\n`);
}

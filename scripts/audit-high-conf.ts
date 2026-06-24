#!/usr/bin/env tsx
/**
 * audit-high-conf.ts — interactive CLI to spot-check the 937 high-confidence
 * auto-applied suggestions. The golden-50 calibration measured tag-set
 * precision at 0.87 on n=28; this audit walks a fresh stratified sample of
 * 50 high-conf notes and asks the human whether each SECONDARY tag was
 * actually correct.
 *
 * Why secondaries? primary_hit_rate was 1.00 on golden-50, so the open
 * question is: how often does the classifier hallucinate a junk secondary?
 *
 * INPUTS
 *   local D1 board-db  — tag_suggestions joined with notes (high-conf only)
 *
 * OUTPUT
 *   db/eval/audit-high-conf.jsonl — append-only; resumable across runs
 *
 * KEYS (per secondary tag):
 *   k / <enter>     keep the tag (it's correct)
 *   d               drop the tag (false positive)
 *   ?               show help
 *
 * PER NOTE:
 *   p               primary is wrong (rare; flags the whole row)
 *   s               skip this note (text is junk / unclassifiable)
 *   q               save + quit
 *
 * USAGE
 *   tsx scripts/audit-high-conf.ts            # audit 50, resumable
 *   tsx scripts/audit-high-conf.ts --target 30
 *   tsx scripts/audit-high-conf.ts --reset    # wipe audit log
 *   tsx scripts/audit-high-conf.ts --refresh  # re-fetch sample from D1
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execFileSync } from 'node:child_process';

// ---- paths ----------------------------------------------------------------
const HERE = new URL('.', import.meta.url).pathname;
const REPO = resolve(HERE, '..');
const P_OUT    = resolve(REPO, 'db/eval/audit-high-conf.jsonl');
const P_CACHE  = resolve(REPO, 'db/eval/.audit-sample-cache.json');

// ---- argv -----------------------------------------------------------------
const argv = process.argv.slice(2);
const TARGET  = (() => { const i = argv.indexOf('--target'); return i >= 0 ? Number(argv[i + 1]) : 50; })();
const RESET   = argv.includes('--reset');
const REFRESH = argv.includes('--refresh');

// ---- types ----------------------------------------------------------------
type SampleRow = {
  uuid: string;
  text: string;
  primary_tag: string;
  suggested_tags: string;        // JSON-encoded string[] from D1
  rationale: string | null;
};
type AuditRow = {
  uuid: string;
  text: string;
  primary: string;
  primary_kept: boolean;
  secondaries: Array<{ tag: string; kept: boolean }>;
  status: 'reviewed' | 'skipped';
  audited_at: number;
};

// ---- ANSI -----------------------------------------------------------------
const A = {
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  gray:   (s: string) => `\x1b[90m${s}\x1b[0m`,
};

// ---- helpers --------------------------------------------------------------
function read_jsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as T);
}

function fetchSampleFromD1(target: number): SampleRow[] {
  // Stratify by primary_tag with ROW_NUMBER, then pull up to 5 per primary.
  // ORDER BY RANDOM() in the partition gives a fresh sample each invocation.
  // Collapse to a single line: when this was multi-line, JSON.stringify
  // escaped the newlines as literal "\n", and bash double-quote parsing
  // kept them as backslash-n, which SQLite rejected at offset 16.
  // We also use execFileSync (no shell) to avoid quoting pitfalls entirely.
  const sql = (
    `WITH ranked AS (` +
    ` SELECT` +
    `  ts.uuid AS uuid,` +
    `  n.text AS text,` +
    `  ts.primary_tag AS primary_tag,` +
    `  ts.suggested_tags AS suggested_tags,` +
    `  ts.rationale AS rationale,` +
    `  ROW_NUMBER() OVER (PARTITION BY ts.primary_tag ORDER BY RANDOM()) AS rn` +
    ` FROM tag_suggestions ts` +
    ` JOIN notes n ON n.uuid = ts.uuid` +
    ` WHERE ts.confidence = 'high' AND ts.applied_at IS NOT NULL` +
    `)` +
    ` SELECT uuid, text, primary_tag, suggested_tags, rationale` +
    ` FROM ranked WHERE rn <= 5` +
    ` ORDER BY RANDOM()` +
    ` LIMIT ${target * 2};`
  );

  process.stderr.write(A.dim('[audit] fetching stratified sample from local D1…\n'));
  const raw = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'board-db', '--local', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  // wrangler --json output is an array of result envelopes
  const arr = JSON.parse(raw);
  const rows: SampleRow[] = (arr[0]?.results ?? arr.results ?? arr) as SampleRow[];
  return rows.slice(0, target);
}

function getSample(target: number): SampleRow[] {
  if (REFRESH || !existsSync(P_CACHE)) {
    const fresh = fetchSampleFromD1(target);
    mkdirSync(dirname(P_CACHE), { recursive: true });
    writeFileSync(P_CACHE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  return JSON.parse(readFileSync(P_CACHE, 'utf8')) as SampleRow[];
}

function printHelp() {
  console.log(A.dim(`
per-secondary keys:
  k / <enter>     keep (the tag is correct for this note)
  d               drop (false positive)
per-note keys (typed before any secondary, or instead of one):
  p               primary tag is wrong (flags the whole row)
  s               skip this note (junk text / unclassifiable)
  q               save + quit (resumable)
  ?               show this help
`));
}

// ---- prepare output -------------------------------------------------------
mkdirSync(dirname(P_OUT), { recursive: true });
if (RESET && existsSync(P_OUT)) {
  writeFileSync(P_OUT, '');
  console.log(A.dim('[audit] --reset: wiped audit-high-conf.jsonl'));
}
if (!existsSync(P_OUT)) writeFileSync(P_OUT, '');

const alreadyAudited = new Set(read_jsonl<AuditRow>(P_OUT).map(r => r.uuid));

// ---- sample ---------------------------------------------------------------
const fullSample = getSample(TARGET);
const sample = fullSample.filter(r => !alreadyAudited.has(r.uuid)).slice(0, TARGET - alreadyAudited.size);

if (sample.length === 0) {
  console.log(`[audit] ${alreadyAudited.size}/${TARGET} already audited. Nothing left in cached sample.`);
  console.log(`[audit] use --refresh to pull a new sample, or --reset to start over.`);
  process.exit(0);
}

// ---- main loop ------------------------------------------------------------
const rl = createInterface({ input, output, terminal: true });
let i = 0;
const startCount = alreadyAudited.size;

console.log(`\n${A.bold('audit-high-conf')}  target=${TARGET}  already=${startCount}  remaining=${sample.length}`);
console.log(A.dim('  ? for help · k=keep · d=drop · p=primary-wrong · s=skip · q=save+quit'));

function parseTags(json: string): string[] {
  try { const x = JSON.parse(json); return Array.isArray(x) ? x.map(String) : []; }
  catch { return []; }
}

try {
  outer: while (i < sample.length) {
    const row = sample[i]!;
    const all = parseTags(row.suggested_tags);
    const primary = row.primary_tag;
    const secondaries = all.filter(t => t !== primary);

    console.log(`\n${A.dim('─'.repeat(78))}`);
    console.log(`${A.bold(`[${startCount + i + 1}/${TARGET}]`)}  ${A.cyan(row.uuid)}`);
    const lines = (row.text ?? '').split('\n').slice(0, 12);
    for (const l of lines) console.log(`  ${l}`);
    if ((row.text ?? '').split('\n').length > 12) {
      console.log(A.dim(`  … (+${row.text.split('\n').length - 12} more lines)`));
    }
    if (row.rationale) console.log(A.dim(`  rationale: ${row.rationale}`));

    console.log(`\n  ${A.bold('primary:')} ${A.green(primary)}`);
    console.log(`  ${A.bold('secondaries:')} ${secondaries.length === 0 ? A.dim('(none)') : secondaries.map(t => `[${t}]`).join(' ')}`);

    // First-level prompt: can be p/s/q/? OR start of secondary walk (k/d)
    if (secondaries.length === 0) {
      const ans = (await rl.question(`  ${A.dim('any-key (p=primary wrong, s=skip, k=primary ok, q=quit):')} `)).trim().toLowerCase();
      if (ans === '?') { printHelp(); continue; }
      if (ans === 'q') break;
      if (ans === 's') {
        appendFileSync(P_OUT, JSON.stringify({ uuid: row.uuid, text: row.text, primary, primary_kept: false, secondaries: [], status: 'skipped', audited_at: Date.now() } satisfies AuditRow) + '\n');
        i++; continue;
      }
      const primaryWrong = ans === 'p';
      appendFileSync(P_OUT, JSON.stringify({ uuid: row.uuid, text: row.text, primary, primary_kept: !primaryWrong, secondaries: [], status: 'reviewed', audited_at: Date.now() } satisfies AuditRow) + '\n');
      console.log(`  ${primaryWrong ? A.red('✗ primary wrong') : A.green('✓ primary ok')}`);
      i++; continue;
    }

    // Walk each secondary
    const secResults: Array<{ tag: string; kept: boolean }> = [];
    let primary_kept = true;
    for (let s = 0; s < secondaries.length; s++) {
      const tag = secondaries[s]!;
      const ans = (await rl.question(`    ${A.bold(tag)} ${A.dim('[k/d/p/s/q/?]')} → `)).trim().toLowerCase();
      if (ans === '?') { printHelp(); s--; continue; }
      if (ans === 'q') { i = sample.length; break outer; }
      if (ans === 's') {
        appendFileSync(P_OUT, JSON.stringify({ uuid: row.uuid, text: row.text, primary, primary_kept: true, secondaries: [], status: 'skipped', audited_at: Date.now() } satisfies AuditRow) + '\n');
        i++; continue outer;
      }
      if (ans === 'p') {
        primary_kept = false;
        s--; // re-prompt for the secondary
        console.log(A.red('    (primary flagged wrong; continuing with secondaries)'));
        continue;
      }
      if (ans === 'd') { secResults.push({ tag, kept: false }); console.log(`    ${A.red('✗ dropped')} ${tag}`); continue; }
      // default keep (k or empty)
      secResults.push({ tag, kept: true }); console.log(`    ${A.green('✓ kept')}    ${tag}`);
    }

    appendFileSync(P_OUT, JSON.stringify({ uuid: row.uuid, text: row.text, primary, primary_kept, secondaries: secResults, status: 'reviewed', audited_at: Date.now() } satisfies AuditRow) + '\n');
    i++;
  }
} finally {
  rl.close();
}

// ---- summary --------------------------------------------------------------
const allAudits = read_jsonl<AuditRow>(P_OUT);
const reviewed = allAudits.filter(r => r.status === 'reviewed');
const totalNotes = reviewed.length;
const primaryWrong = reviewed.filter(r => !r.primary_kept).length;
const allSecs = reviewed.flatMap(r => r.secondaries);
const droppedSecs = allSecs.filter(s => !s.kept);
const tagFP = new Map<string, { kept: number; dropped: number }>();
for (const s of allSecs) {
  const t = tagFP.get(s.tag) ?? { kept: 0, dropped: 0 };
  if (s.kept) t.kept++; else t.dropped++;
  tagFP.set(s.tag, t);
}

const fmt = (n: number, d: number) => d === 0 ? '—' : `${(n/d*100).toFixed(1)}%`;

console.log(`\n${A.bold('─── summary ───')}`);
console.log(`  notes reviewed:         ${totalNotes}`);
console.log(`  primary wrong:          ${primaryWrong}  (${fmt(primaryWrong, totalNotes)})`);
console.log(`  secondaries shown:      ${allSecs.length}`);
console.log(`  secondaries dropped:    ${droppedSecs.length}  (${fmt(droppedSecs.length, allSecs.length)})`);
console.log();
console.log(`  ${A.bold('per-secondary-tag false-positive rate:')}`);
const sorted = [...tagFP.entries()].sort((a,b) => (b[1].dropped+b[1].kept) - (a[1].dropped+a[1].kept));
for (const [tag, {kept, dropped}] of sorted) {
  const total = kept + dropped;
  const rate = total === 0 ? 0 : dropped / total;
  const flag = rate >= 0.25 ? A.red(' ⚠') : rate >= 0.10 ? A.yellow(' ·') : '';
  console.log(`    ${dropped}/${total}  ${tag}${flag}`);
}

const fpRate = allSecs.length === 0 ? 0 : droppedSecs.length / allSecs.length;
console.log();
if (fpRate < 0.05) {
  console.log(`  ${A.green('verdict:')} secondary FP rate < 5% — D-015 holds. Ship as-is.`);
} else if (fpRate < 0.15) {
  console.log(`  ${A.yellow('verdict:')} secondary FP rate ${fmt(droppedSecs.length, allSecs.length)} — borderline. Consider per-tag guardrails for the ⚠ tags above before remote push.`);
} else {
  console.log(`  ${A.red('verdict:')} secondary FP rate ${fmt(droppedSecs.length, allSecs.length)} ≥ 15% — retreat to 'auto-apply primary only.' Need rollback + reload.`);
}
console.log(`\n  ${A.dim(`written: ${P_OUT}`)}`);

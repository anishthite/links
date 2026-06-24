#!/usr/bin/env tsx
/**
 * tag-golden.ts — interactive CLI for hand-tagging a stratified 50-note sample
 * with LLM suggestions as quick-pick options.
 *
 * The output is the gold-standard ground truth used to:
 *   - calibrate confidence thresholds in Phase 5 review UI
 *   - eval Workers AI vs other models in Phase 6
 *   - sanity-check the bulk LLM suggestions before mass-accept
 *
 * INPUTS
 *   db/tag-suggestions-raw.jsonl    — stitched output of Track B
 *   db/clusters/clusters.jsonl      — per-note cluster_id (for stratification)
 *   db/clusters/labels.json         — cluster human names (display only)
 *   newnotes.json                   — full text + title
 *
 * OUTPUT
 *   db/eval/golden-50.jsonl  — append-only; resumable across runs
 *
 * KEYS (one keystroke + enter)
 *   1 / 2 / 3      accept the Nth suggestion's tags as-is
 *   tag,tag,tag    custom tags (comma-separated, lowercase kebab-case)
 *   s              skip this note (don't include in golden set)
 *   b              go back one note (lets you fix a typo)
 *   q              save + quit
 *   ?              show help
 *
 * USAGE
 *   tsx scripts/tag-golden.ts            # tag until 50 done or 'q'
 *   tsx scripts/tag-golden.ts --resume   # explicit resume (same as default)
 *   tsx scripts/tag-golden.ts --target 100  # tag 100 instead
 *   tsx scripts/tag-golden.ts --reset    # wipe golden-50.jsonl and start over
 *   tsx scripts/tag-golden.ts --out db/eval/holdout-50.jsonl --exclude db/eval/golden-50.jsonl
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ---- paths ----------------------------------------------------------------
const HERE = new URL('.', import.meta.url).pathname;
const REPO = resolve(HERE, '..');
const P_SUGGEST = resolve(REPO, 'db/tag-suggestions-raw.jsonl');
const P_CLUSTERS = resolve(REPO, 'db/clusters/clusters.jsonl');
const P_LABELS = resolve(REPO, 'db/clusters/labels.json');
const P_NOTES = resolve(REPO, 'newnotes.json');
const DEFAULT_OUT = resolve(REPO, 'db/eval/golden-50.jsonl');

// ---- argv -----------------------------------------------------------------
const argv = process.argv.slice(2);
function argValue(name: string): string | null {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? null : null;
}
function argValues(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
    else if (a === name && argv[i + 1]) out.push(argv[i + 1]!);
  }
  return out;
}
const TARGET = Number(argValue('--target') ?? 50);
const RESET = argv.includes('--reset');
const P_OUT = argValue('--out') ? resolve(REPO, argValue('--out')!) : DEFAULT_OUT;
const EXCLUDE_PATHS = argValues('--exclude').map((p) => resolve(REPO, p));

// ---- types ----------------------------------------------------------------
type Suggestion = {
  uuid: string;
  suggested_tags: string[];
  primary: string;
  confidence: 'high' | 'medium' | 'low' | string;
  rationale: string;
};
type ClusterAssign = { uuid: string; cluster_id: number; distance: number };
type GoldenRow = {
  uuid: string;
  text: string;
  accepted_tags: string[];
  source: 'suggestion' | 'manual' | 'skip';
  suggestion_index: number | null;
  cluster_id: number;
  tagged_at: number;
};

// ---- safety: required inputs exist? --------------------------------------
function require_file(p: string, hint: string) {
  if (!existsSync(p)) {
    console.error(`\n[tag-golden] missing: ${p}`);
    console.error(`[tag-golden] ${hint}\n`);
    process.exit(2);
  }
}
require_file(P_SUGGEST, 'Run subagent batch + python3 scripts/stitch-suggestions.py first.');
require_file(P_CLUSTERS, 'Run python3 scripts/cluster-notes.py first.');
require_file(P_NOTES, 'Place newnotes.json at the repo root.');

// ---- load -----------------------------------------------------------------
function read_jsonl<T>(p: string): T[] {
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

const suggestions = new Map<string, Suggestion>();
for (const s of read_jsonl<Suggestion>(P_SUGGEST)) suggestions.set(s.uuid, s);

const clusterById = new Map<string, ClusterAssign>();
for (const c of read_jsonl<ClusterAssign>(P_CLUSTERS)) clusterById.set(c.uuid, c);

const clusterLabels: Record<number, { proposed_name: string; primary_tag: string }> = {};
if (existsSync(P_LABELS)) {
  const labels = JSON.parse(readFileSync(P_LABELS, 'utf8'));
  for (const c of labels.clusters ?? []) {
    clusterLabels[c.cluster_id] = {
      proposed_name: c.proposed_name ?? '?',
      primary_tag: c.primary_tag ?? '?',
    };
  }
}

const allNotes = JSON.parse(readFileSync(P_NOTES, 'utf8')) as Array<{
  uuid?: string;
  _id?: { $oid: string };
  text?: string;
  title?: string;
}>;
const noteByUuid = new Map<string, { text: string; title: string }>();
for (const n of allNotes) {
  const uid = n.uuid ?? n._id?.$oid;
  if (!uid) continue;
  noteByUuid.set(uid, { text: (n.text ?? '').trim(), title: (n.title ?? '').trim() });
}

// ---- prepare output -------------------------------------------------------
mkdirSync(dirname(P_OUT), { recursive: true });
if (RESET && existsSync(P_OUT)) {
  writeFileSync(P_OUT, '');
  console.log('[tag-golden] --reset: wiped golden-50.jsonl');
}
if (!existsSync(P_OUT)) writeFileSync(P_OUT, '');

const alreadyTagged = new Set<string>();
for (const p of [P_OUT, ...EXCLUDE_PATHS]) {
  if (!existsSync(p)) continue;
  for (const row of read_jsonl<GoldenRow>(p)) alreadyTagged.add(row.uuid);
}

// ---- stratified sample ----------------------------------------------------
// Sample TARGET notes balanced across clusters, with a small length-bucket
// balance so we don't only get short fragments. Weighted by cluster size.
function pickSample(target: number): Array<{ uuid: string; cluster_id: number }> {
  const byCluster = new Map<number, string[]>();
  for (const [uuid, c] of clusterById.entries()) {
    if (alreadyTagged.has(uuid)) continue;
    const arr = byCluster.get(c.cluster_id) ?? [];
    arr.push(uuid);
    byCluster.set(c.cluster_id, arr);
  }
  // shuffle each cluster's pool (Fisher-Yates, seed-free — deterministic enough for golden set)
  for (const arr of byCluster.values()) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
  }
  // sort clusters by remaining size desc, round-robin pull until target reached
  const clusters = [...byCluster.entries()].sort((a, b) => b[1].length - a[1].length);
  const out: Array<{ uuid: string; cluster_id: number }> = [];
  while (out.length < target) {
    let progressed = false;
    for (const [cid, pool] of clusters) {
      if (out.length >= target) break;
      const uuid = pool.shift();
      if (!uuid) continue;
      out.push({ uuid, cluster_id: cid });
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
}

const sample = pickSample(TARGET - alreadyTagged.size);

if (sample.length === 0) {
  console.log(`[tag-golden] already have ${alreadyTagged.size} tagged; target=${TARGET}. Nothing to do.`);
  console.log(`[tag-golden] use --target N to extend, or --reset to start over.`);
  process.exit(0);
}

// ---- ui helpers -----------------------------------------------------------
const ANSI = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

function confColor(c: string): string {
  if (c === 'high') return ANSI.green(c);
  if (c === 'medium') return ANSI.yellow(c);
  return ANSI.red(c);
}

function normalizeTags(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
    .filter(Boolean);
}

function printHelp() {
  console.log(ANSI.dim(`
keys (one keystroke + enter):
  1 / 2 / 3       accept the Nth suggestion's tags as-is
  tag,tag,tag     custom tags (comma-separated; #-prefix optional)
  s               skip this note (don't include in golden set)
  q               save + quit (resumable on next run)
  ?               show this help
`));
}

// ---- main loop ------------------------------------------------------------
const rl = createInterface({ input, output, terminal: true });
let i = 0;
const startCount = alreadyTagged.size;

console.log(`\n${ANSI.bold('tag-golden')}  target=${TARGET}  already_tagged=${startCount}  remaining=${sample.length}`);
console.log(ANSI.dim(`  out=${P_OUT}`));
if (EXCLUDE_PATHS.length) console.log(ANSI.dim(`  exclude=${EXCLUDE_PATHS.join(', ')}`));
console.log(ANSI.dim('  ? for help'));

try {
  while (i < sample.length) {
    const { uuid, cluster_id } = sample[i]!;
    const note = noteByUuid.get(uuid);
    if (!note) { i++; continue; }
    const sug = suggestions.get(uuid);
    const clusterName = clusterLabels[cluster_id]?.proposed_name ?? `cluster-${cluster_id}`;

    console.log(`\n${ANSI.dim('─'.repeat(78))}`);
    console.log(`${ANSI.bold(`[${startCount + i + 1}/${TARGET}]`)}  ${ANSI.cyan(uuid)}  ${ANSI.gray(`cluster=${cluster_id} (${clusterName})`)}`);
    if (note.title) console.log(`${ANSI.bold('title:')} ${note.title}`);
    const lines = note.text.split('\n').slice(0, 12);
    for (const l of lines) console.log(`  ${l}`);
    if (note.text.split('\n').length > 12) console.log(ANSI.dim(`  … (+${note.text.split('\n').length - 12} more lines)`));

    if (sug) {
      console.log('\n  suggestions:');
      const opts: string[][] = [];
      // Option 1: primary alone
      if (sug.primary) {
        opts.push([sug.primary]);
        console.log(`    ${ANSI.bold('1)')} [${sug.primary}]    ${confColor(sug.confidence)}  ${ANSI.dim(sug.rationale)}`);
      }
      // Option 2: full set
      if (sug.suggested_tags && sug.suggested_tags.length > 1) {
        opts.push(sug.suggested_tags);
        console.log(`    ${ANSI.bold('2)')} [${sug.suggested_tags.join(', ')}]    ${ANSI.dim('(all suggested)')}`);
      }
      // store for accept handling
      (sample[i] as any)._opts = opts;
    } else {
      console.log(ANSI.dim('  (no LLM suggestion available for this uuid)'));
      (sample[i] as any)._opts = [];
    }

    const answer = (await rl.question('  → ')).trim();
    if (!answer) continue;
    if (answer === '?') { printHelp(); continue; }
    if (answer === 'q') break;
    if (answer === 's') {
      const row: GoldenRow = {
        uuid, text: note.text, accepted_tags: [], source: 'skip',
        suggestion_index: null, cluster_id, tagged_at: Date.now(),
      };
      appendFileSync(P_OUT, JSON.stringify(row) + '\n');
      i++;
      continue;
    }

    const opts: string[][] = (sample[i] as any)._opts ?? [];
    let tags: string[];
    let source: 'suggestion' | 'manual';
    let suggestion_index: number | null;
    if (/^[123]$/.test(answer) && opts[Number(answer) - 1]) {
      tags = opts[Number(answer) - 1]!;
      source = 'suggestion';
      suggestion_index = Number(answer) - 1;
    } else {
      tags = normalizeTags(answer);
      if (tags.length === 0) { console.log(ANSI.red('  (no tags parsed; try again)')); continue; }
      source = 'manual';
      suggestion_index = null;
    }

    const row: GoldenRow = {
      uuid, text: note.text, accepted_tags: tags, source,
      suggestion_index, cluster_id, tagged_at: Date.now(),
    };
    appendFileSync(P_OUT, JSON.stringify(row) + '\n');
    console.log(`  ${ANSI.green('✓')} ${tags.join(', ')}`);
    i++;
  }
} finally {
  rl.close();
}

const finalCount = read_jsonl<GoldenRow>(P_OUT).length;
const real = read_jsonl<GoldenRow>(P_OUT).filter((r) => r.source !== 'skip').length;
console.log(`\n${ANSI.bold('done')}  written=${finalCount}  real=${real}  skipped=${finalCount - real}`);
console.log(`        ${P_OUT}`);

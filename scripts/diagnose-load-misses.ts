#!/usr/bin/env tsx
// Diagnose why 20 rows from db/tag-suggestions-final.jsonl didn't land in
// the D1 tag_suggestions table.
//
// The loader (scripts/load-suggestions.ts) joins on content_hash because
// import-newnotes.ts mints fresh uuids. 1,728 rows generated INSERT OR
// REPLACE statements but only 1,708 net rows landed → 20-row gap.
//
// Three plausible causes:
//   1. "orphan"     — content_hash absent from notes table entirely
//   2. "text_drift" — a notes row has nearly-identical normalized text but
//                     different content_hash (whitespace/punctuation drift
//                     between newnotes.json and the original D1 import)
//   3. "dedup"      — multiple final.jsonl rows resolve to the same
//                     content_hash; INSERT OR REPLACE keeps only the last,
//                     "losing" N−1 rows per group.
//
// Output: db/eval/load-misses.json (full diagnostic) + terse markdown stdout.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

import { contentHash } from './lib/content-hash';

type FinalRow = {
  uuid: string;
  suggested_tags: string[];
  primary: string;
  confidence: 'high' | 'medium' | 'low';
};
type MongoDate = { $date: { $numberLong: string } };
type MongoNote = { uuid: string; text: string; updated: MongoDate };
type D1Row = { uuid: string; content_hash: string | null; text: string };
type WranglerResult = [{ success: boolean; results: D1Row[] }];

const HERE = new URL('.', import.meta.url).pathname;

function findFile(name: string, envVar?: string): string {
  if (envVar && process.env[envVar]) return process.env[envVar]!;
  for (const cand of [resolve(HERE, '..', name), resolve(HERE, '../..', name)]) {
    if (existsSync(cand)) return cand;
  }
  throw new Error(`${name} not found`);
}

// Aggressive normalization for text_drift fuzzy matching — much looser than
// contentHash's normalization (which only folds CRLF and trims trailing ws).
// Lowercase, collapse runs of whitespace, strip leading/trailing non-alphanum.
function normalizeForDrift(t: string): string {
  return t
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .trim();
}

const FINAL    = findFile('db/tag-suggestions-final.jsonl');
const NEWNOTES = findFile('newnotes.json', 'NEWNOTES_PATH');

// 1) Source uuid → text from newnotes.json (same logic as load-suggestions.ts).
const mongoNotes = JSON.parse(readFileSync(NEWNOTES, 'utf8')) as MongoNote[];
const textBySourceUuid = new Map<string, string>();
for (const n of mongoNotes) {
  if (n.text && n.text.trim().length > 0) {
    textBySourceUuid.set(n.uuid, n.text);
  }
}

// 2) Walk final.jsonl, compute each row's content_hash.
type FinalRecord = FinalRow & { text: string; hash: string };
const finalRows: FinalRecord[] = [];
const finalLines = readFileSync(FINAL, 'utf8').split('\n');
let missingSourceText = 0;
for (const line of finalLines) {
  if (!line.trim()) continue;
  const r = JSON.parse(line) as FinalRow;
  const text = textBySourceUuid.get(r.uuid);
  if (!text) { missingSourceText++; continue; }
  finalRows.push({ ...r, text, hash: contentHash(text) });
}

// 3) Pull all live notes from D1 in one shot.
console.error(`[diagnose] querying D1 for all notes (uuid, content_hash, text)…`);
const queryResult = execSync(
  `npx wrangler d1 execute board-db --local --json --command ` +
  `"SELECT uuid, content_hash, text FROM notes"`,
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);
const d1Rows = (JSON.parse(queryResult) as WranglerResult)[0]?.results ?? [];

const d1HashSet = new Set<string>();
const d1ByNormText: Map<string, D1Row[]> = new Map();
for (const row of d1Rows) {
  if (row.content_hash) d1HashSet.add(row.content_hash);
  const norm = normalizeForDrift(row.text);
  if (!d1ByNormText.has(norm)) d1ByNormText.set(norm, []);
  d1ByNormText.get(norm)!.push(row);
}

// 4) Group final.jsonl rows by content_hash (to detect dedup-within-source).
const finalByHash = new Map<string, FinalRecord[]>();
for (const r of finalRows) {
  if (!finalByHash.has(r.hash)) finalByHash.set(r.hash, []);
  finalByHash.get(r.hash)!.push(r);
}

// 5) Classify every "missing" row. A row is missing if either:
//    (a) its hash is absent from D1, OR
//    (b) its hash IS in D1 but its content_hash bucket has >1 final rows —
//        only one wins INSERT OR REPLACE, the others are dedup'd away.
type Miss = {
  uuid: string;
  content_hash: string;
  text_preview: string;
  cause: 'orphan' | 'text_drift' | 'dedup';
  nearest_match_uuid?: string;
  nearest_match_hash?: string;
};
const misses: Miss[] = [];

for (const [hash, group] of finalByHash) {
  if (d1HashSet.has(hash)) {
    // Hash is in D1 → one row lands. group.length − 1 are dedup misses.
    if (group.length > 1) {
      // Keep the first (arbitrary but deterministic); flag the rest as dedup.
      for (let i = 1; i < group.length; i++) {
        const r = group[i]!;
        misses.push({
          uuid: r.uuid,
          content_hash: hash.slice(0, 12),
          text_preview: r.text.slice(0, 60).replace(/\n/g, ' '),
          cause: 'dedup',
          nearest_match_uuid: group[0]!.uuid,  // the source uuid that "won"
        });
      }
    }
  } else {
    // Hash absent → either orphan or text_drift. Every row in this group is a miss.
    for (const r of group) {
      const norm = normalizeForDrift(r.text);
      const driftMatches = d1ByNormText.get(norm);
      if (driftMatches && driftMatches.length > 0) {
        misses.push({
          uuid: r.uuid,
          content_hash: hash.slice(0, 12),
          text_preview: r.text.slice(0, 60).replace(/\n/g, ' '),
          cause: 'text_drift',
          nearest_match_uuid: driftMatches[0]!.uuid,
          nearest_match_hash: (driftMatches[0]!.content_hash ?? '?').slice(0, 12),
        });
      } else {
        misses.push({
          uuid: r.uuid,
          content_hash: hash.slice(0, 12),
          text_preview: r.text.slice(0, 60).replace(/\n/g, ' '),
          cause: 'orphan',
        });
      }
    }
  }
}

// 6) Breakdown + write JSON.
const breakdown: Record<Miss['cause'], number> = { orphan: 0, text_drift: 0, dedup: 0 };
for (const m of misses) breakdown[m.cause]++;

const outPath = resolve(HERE, '..', 'db', 'eval', 'load-misses.json');
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generated_at: Date.now(),
      final_jsonl_rows: finalRows.length,
      d1_notes_rows: d1Rows.length,
      missing_source_text: missingSourceText,
      missed_count: misses.length,
      breakdown,
      misses,
    },
    null, 2,
  ) + '\n',
);

// 7) Terse markdown table.
console.log();
console.log(`# Load-miss diagnosis`);
console.log();
console.log(`| metric | value |`);
console.log(`|---|---:|`);
console.log(`| final.jsonl rows | ${finalRows.length} |`);
console.log(`| missing source text (skipped) | ${missingSourceText} |`);
console.log(`| D1 notes rows | ${d1Rows.length} |`);
console.log(`| total misses | ${misses.length} |`);
console.log(`| └─ orphan | ${breakdown.orphan} |`);
console.log(`| └─ text_drift | ${breakdown.text_drift} |`);
console.log(`| └─ dedup | ${breakdown.dedup} |`);
console.log();
console.log(`## misses (first 25)`);
console.log();
console.log(`| cause | source uuid | hash | preview | nearest |`);
console.log(`|---|---|---|---|---|`);
for (const m of misses.slice(0, 25)) {
  console.log(
    `| ${m.cause} | ${m.uuid} | ${m.content_hash} | ${m.text_preview.replace(/\|/g, '\\|')} | ${m.nearest_match_uuid ?? '—'} |`,
  );
}
console.log();
console.log(`Full diagnostic: ${outPath}`);

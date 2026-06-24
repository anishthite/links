#!/usr/bin/env tsx
/**
 * eval-classifier.ts — golden-50 calibration for the closed-taxonomy classifier.
 *
 * Compares db/tag-suggestions-final.jsonl (predictions) against
 * db/eval/golden-50.jsonl (hand-tagged ground truth).
 *
 * Normalizes golden `accepted_tags` via the same alias table the classifier
 * used (`taxonomy.md` + `stitch-suggestions.py` + `apply-promotions.py`)
 * because the hand-tag CLI tokenized multi-word tags into adjacent fragments
 * (e.g. "things to learn" → ["things","to","learn"]) that the canonical
 * taxonomy folds back together (→ "to-learn").
 *
 * Emits:
 *   - stdout: terse markdown report
 *   - db/eval/calibration.json: machine-readable metrics + threshold rec
 *
 * Run:  npx tsx scripts/eval-classifier.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..");
const PRED_PATH = resolve(REPO, "db/tag-suggestions-final.jsonl");
const GOLD_PATH = resolve(REPO, "db/eval/golden-50.jsonl");
const OUT_PATH = resolve(REPO, "db/eval/calibration.json");

/** 32-tag canonical taxonomy (post round-2 promotion). Mirrors taxonomy.md. */
const CANONICAL = new Set<string>([
  "idea", "ai", "thought", "quote", "link", "llm", "article", "mental-model",
  "humor", "robotics", "question", "unclassifiable", "health", "tweet", "hot-take",
  "lesson", "infra", "hardware", "philosophy", "todo", "reading-list", "physics",
  "commerce", "social", "ml", "design", "writing", "finance", "to-learn",
  "people", "transportation", "watch-list",
]);

/** Single-token aliases applied first. */
const SINGLE_ALIASES: Record<string, string> = {
  questions: "question",
  mental: "mental-model",
  gpt: "ai",
  watchlist: "watch-list",
  contact: "people",
};

/** Multi-token folds. Each entry: if the array contains this exact sequence
 *  of adjacent tokens, replace the run with the replacement tokens. */
const MULTI_FOLDS: Array<{ from: string[]; to: string[] }> = [
  { from: ["things", "to", "learn"], to: ["to-learn"] },
  { from: ["physics", "to", "learn"], to: ["physics", "to-learn"] },
  { from: ["hot", "take"], to: ["hot-take"] },
];

/** Tags to drop entirely (CLI tokenization noise). */
const DROP = new Set<string>(["1"]);

type PredRow = {
  uuid: string;
  suggested_tags: string[];
  primary: string;
  proposed_tag: string | null;
  confidence: "high" | "medium" | "low";
  rationale: string;
};

type GoldRow = {
  uuid: string;
  text: string;
  accepted_tags: string[];
  source: string;
  suggestion_index: number | null;
  cluster_id: number;
  tagged_at: number;
};

type Confidence = "high" | "medium" | "low";

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

/** Normalize a raw golden accepted_tags array into canonical-aligned tags. */
function normalizeGolden(raw: string[]): { tags: string[]; oov: string[] } {
  // 1. Lowercase + trim. Keep original order for multi-fold matching.
  let toks = raw.map((t) => t.toLowerCase().trim()).filter((t) => t.length > 0);

  // 2. Drop noise tokens.
  toks = toks.filter((t) => !DROP.has(t));

  // 3. Apply multi-token folds (longest first to be safe; current folds are
  //    non-overlapping but this is future-proof).
  const folds = [...MULTI_FOLDS].sort((a, b) => b.from.length - a.from.length);
  for (const fold of folds) {
    const out: string[] = [];
    let i = 0;
    while (i < toks.length) {
      const slice = toks.slice(i, i + fold.from.length);
      if (
        slice.length === fold.from.length &&
        slice.every((tok, j) => tok === fold.from[j])
      ) {
        out.push(...fold.to);
        i += fold.from.length;
      } else {
        // Loop guard `i < toks.length` ensures toks[i] is defined.
        out.push(toks[i]!);
        i += 1;
      }
    }
    toks = out;
  }

  // 4. Apply single-token aliases.
  toks = toks.map((t) => SINGLE_ALIASES[t] ?? t);

  // 5. Dedupe (preserve first-seen order).
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of toks) {
    if (!seen.has(t)) {
      seen.add(t);
      deduped.push(t);
    }
  }

  // 6. Split OOV (still kept in tags — we want to count them against recall —
  //    but logged so we know they exist).
  const oov = deduped.filter((t) => !CANONICAL.has(t));
  return { tags: deduped, oov };
}

function setOps(pred: string[], gold: string[]) {
  const pSet = new Set(pred);
  const gSet = new Set(gold);
  let inter = 0;
  for (const t of pSet) if (gSet.has(t)) inter++;
  const p = pSet.size === 0 ? 0 : inter / pSet.size;
  const r = gSet.size === 0 ? 0 : inter / gSet.size;
  const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);
  return { p, r, f1, intersection: inter, predN: pSet.size, goldN: gSet.size };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round(x: number, d = 4): number {
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
}

// ───────────────────────────────────────────────────────────────────────────

const preds = readJsonl<PredRow>(PRED_PATH);
const golds = readJsonl<GoldRow>(GOLD_PATH);

const predByUuid = new Map<string, PredRow>();
for (const p of preds) predByUuid.set(p.uuid, p);

const matched: Array<{
  uuid: string;
  pred: PredRow;
  gold_raw: string[];
  gold: string[];
  oov: string[];
}> = [];
const missingUuids: string[] = [];

for (const g of golds) {
  const p = predByUuid.get(g.uuid);
  if (!p) {
    missingUuids.push(g.uuid);
    continue;
  }
  const { tags: gold, oov } = normalizeGolden(g.accepted_tags);
  matched.push({ uuid: g.uuid, pred: p, gold_raw: g.accepted_tags, gold, oov });
}

// ── overall metrics ────────────────────────────────────────────────────────
const perRow = matched.map((m) => {
  const ops = setOps(m.pred.suggested_tags, m.gold);
  const goldSet = new Set(m.gold);
  return {
    uuid: m.uuid,
    confidence: m.pred.confidence,
    p: ops.p,
    r: ops.r,
    f1: ops.f1,
    primaryHit: goldSet.has(m.pred.primary),
    anyOverlap: ops.intersection > 0,
    pred: m.pred.suggested_tags,
    gold: m.gold,
  };
});

const overall = {
  precision: round(mean(perRow.map((r) => r.p))),
  recall: round(mean(perRow.map((r) => r.r))),
  f1: round(mean(perRow.map((r) => r.f1))),
  primary_hit_rate: round(mean(perRow.map((r) => (r.primaryHit ? 1 : 0)))),
  any_overlap_rate: round(mean(perRow.map((r) => (r.anyOverlap ? 1 : 0)))),
};

// ── by-confidence buckets ──────────────────────────────────────────────────
const buckets: Confidence[] = ["high", "medium", "low"];
const byConfidence: Record<
  Confidence,
  { n: number; p: number; r: number; f1: number; primary_hit: number; any_overlap: number }
> = {} as any;
for (const b of buckets) {
  const rows = perRow.filter((r) => r.confidence === b);
  byConfidence[b] = {
    n: rows.length,
    p: round(mean(rows.map((r) => r.p))),
    r: round(mean(rows.map((r) => r.r))),
    f1: round(mean(rows.map((r) => r.f1))),
    primary_hit: round(mean(rows.map((r) => (r.primaryHit ? 1 : 0)))),
    any_overlap: round(mean(rows.map((r) => (r.anyOverlap ? 1 : 0)))),
  };
}

// ── per-tag PRF (binary problem per tag) ───────────────────────────────────
type TagStats = { tp: number; fp: number; fn: number };
const tagStats = new Map<string, TagStats>();
const ensure = (t: string): TagStats => {
  let s = tagStats.get(t);
  if (!s) {
    s = { tp: 0, fp: 0, fn: 0 };
    tagStats.set(t, s);
  }
  return s;
};
for (const m of matched) {
  const predSet = new Set(m.pred.suggested_tags);
  const goldSet = new Set(m.gold);
  const union = new Set<string>([...predSet, ...goldSet]);
  for (const t of union) {
    const s = ensure(t);
    const inPred = predSet.has(t);
    const inGold = goldSet.has(t);
    if (inPred && inGold) s.tp++;
    else if (inPred && !inGold) s.fp++;
    else if (!inPred && inGold) s.fn++;
  }
}
const perTag: Record<
  string,
  { p: number; r: number; f1: number; support_gold: number; support_pred: number; tp: number; fp: number; fn: number }
> = {};
for (const [tag, s] of tagStats.entries()) {
  const p = s.tp + s.fp === 0 ? 0 : s.tp / (s.tp + s.fp);
  const r = s.tp + s.fn === 0 ? 0 : s.tp / (s.tp + s.fn);
  const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);
  perTag[tag] = {
    p: round(p),
    r: round(r),
    f1: round(f1),
    support_gold: s.tp + s.fn,
    support_pred: s.tp + s.fp,
    tp: s.tp,
    fp: s.fp,
    fn: s.fn,
  };
}

// ── recommended threshold ──────────────────────────────────────────────────
// Find the lowest confidence bucket whose precision ≥ 0.9 AND every bucket
// strictly above it also clears 0.9. Implementation: scan high → medium → low.
// First bucket that fails to clear 0.9 stops the chain; the last-cleared
// bucket is the threshold.
let recommended: Confidence | null = null;
const ordered: Confidence[] = ["high", "medium", "low"];
for (const b of ordered) {
  if (byConfidence[b].n === 0) continue;
  if (byConfidence[b].p >= 0.9) {
    recommended = b;
  } else {
    break;
  }
}
const recommendedRationale =
  recommended === null
    ? "no confidence bucket cleared precision ≥ 0.9; auto-apply not recommended"
    : `precision ≥ 0.9 in '${recommended}' bucket and above`;

// ── OOV golden tags ────────────────────────────────────────────────────────
const oovCounts: Record<string, number> = {};
for (const m of matched) {
  for (const t of m.oov) oovCounts[t] = (oovCounts[t] ?? 0) + 1;
}

// ── write JSON ─────────────────────────────────────────────────────────────
const out = {
  generated_at: Date.now(),
  n_matched: matched.length,
  n_missing: missingUuids.length,
  missing_uuids: missingUuids,
  overall,
  by_confidence: byConfidence,
  per_tag: perTag,
  recommended_threshold: recommended,
  recommended_threshold_rationale: recommendedRationale,
  oov_golden_tags: oovCounts,
};
writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");

// ── stdout markdown report ─────────────────────────────────────────────────
const lines: string[] = [];
lines.push("# Classifier calibration — golden-50");
lines.push("");
lines.push(`Matched: **${matched.length} / ${golds.length}**, missing: ${missingUuids.length}`);
if (missingUuids.length > 0) {
  lines.push(`Missing uuids: \`${missingUuids.join(", ")}\``);
}
lines.push("");
lines.push("## Overall");
lines.push("| Metric | Value |");
lines.push("|---|---:|");
lines.push(`| Precision (macro avg) | ${overall.precision} |`);
lines.push(`| Recall    (macro avg) | ${overall.recall} |`);
lines.push(`| F1        (macro avg) | ${overall.f1} |`);
lines.push(`| Primary in gold       | ${overall.primary_hit_rate} |`);
lines.push(`| Any overlap (loose)   | ${overall.any_overlap_rate} |`);
lines.push("");
lines.push("## By confidence bucket");
lines.push("| Bucket | n | P | R | F1 | primary_hit | any_overlap |");
lines.push("|---|---:|---:|---:|---:|---:|---:|");
for (const b of buckets) {
  const x = byConfidence[b];
  lines.push(`| ${b} | ${x.n} | ${x.p} | ${x.r} | ${x.f1} | ${x.primary_hit} | ${x.any_overlap} |`);
}
lines.push("");
lines.push("## Per-tag (top 10 by gold support)");
const tagsByGoldSupport = Object.entries(perTag).sort(
  (a, b) => b[1].support_gold - a[1].support_gold,
);
lines.push("| Tag | support_gold | support_pred | P | R | F1 |");
lines.push("|---|---:|---:|---:|---:|---:|");
for (const [tag, s] of tagsByGoldSupport.slice(0, 10)) {
  lines.push(
    `| ${tag} | ${s.support_gold} | ${s.support_pred} | ${s.p} | ${s.r} | ${s.f1} |`,
  );
}
lines.push("");
lines.push("## Recommended auto-apply threshold");
lines.push(
  `**${recommended ?? "(none)"}** — ${recommendedRationale}.`,
);
lines.push("");
if (Object.keys(oovCounts).length > 0) {
  lines.push("## Out-of-vocab golden tags (after normalization)");
  for (const [t, n] of Object.entries(oovCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${t}\` × ${n}`);
  }
  lines.push("");
}
lines.push(`Wrote: \`${OUT_PATH.replace(REPO + "/", "")}\``);
console.log(lines.join("\n"));

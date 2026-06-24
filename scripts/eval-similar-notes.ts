#!/usr/bin/env tsx

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pipeline } from '@xenova/transformers';

import {
  BEST_SIMILAR_RETRIEVAL_METHOD,
  buildSimilarCorpus,
  rankSimilarNotes,
  SIMILAR_RETRIEVAL_METHODS,
  type SimilarNoteRow,
  type SimilarRetrievalMethod,
} from '../server/lib/similar-note-retrieval';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..');
const REMOTE = process.argv.includes('--remote');
const TARGET = REMOTE ? '--remote' : '--local';
const GOLD_PATH = resolve(REPO, 'db/eval/golden-50.jsonl');
const JSON_OUT = resolve(REPO, 'db/eval/similar-notes-eval.json');
const MD_OUT = resolve(REPO, 'db/eval/similar-notes-eval.md');
const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';

type NoteRowWire = { uuid: string; text: string; tags: string | null; created_at: number; updated_at: number };
type NoteRow = SimilarNoteRow;
type GoldRow = { uuid: string; text: string; accepted_tags: string[] };
type GoldQuery = GoldRow & { tags: string[]; note: NoteRow };
type StrictMethod = SimilarRetrievalMethod | 'embedding_cosine' | 'embedding_hybrid';

type QueryResult = {
  uuid: string;
  relevantTotal: number;
  recallAt10: number;
  hitAt1: boolean;
  hitAt3: boolean;
  reciprocalRank: number;
  firstRelevantRank: number | null;
  top10: string[];
};

type MethodSummary<M extends string> = {
  method: M;
  queries: number;
  recallAt10: number;
  mrrAt10: number;
  hitAt1: number;
  hitAt3: number;
  meanRelevant: number;
  failures: Array<{ uuid: string; relevantTotal: number; top10: string[] }>;
};

type EvalResult = {
  source: 'local' | 'remote';
  corpusSize: number;
  goldenSize: number;
  currentLiveMethod: SimilarRetrievalMethod;
  strictBenchmark: {
    description: string;
    queries: number;
    winner: StrictMethod;
    methods: MethodSummary<StrictMethod>[];
  };
  proxyBenchmark: {
    description: string;
    queries: number;
    winner: SimilarRetrievalMethod;
    methods: MethodSummary<SimilarRetrievalMethod>[];
  };
  recommendedLiveMethod: SimilarRetrievalMethod;
  recommendationBasis: string;
};

const STRICT_METHODS: StrictMethod[] = [
  'overlap',
  'bm25',
  'chargram',
  'hybrid_rrf',
  'hybrid_weighted',
  'embedding_cosine',
  'embedding_hybrid',
];

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

function fetchRows(): NoteRow[] {
  const out = execSync(
    `wrangler d1 execute board-db ${TARGET} --json --command "SELECT uuid, text, tags, created_at, updated_at FROM notes ORDER BY updated_at DESC"`,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 },
  );
  const parsed = JSON.parse(out) as Array<{ results: NoteRowWire[] }>;
  return (parsed[0]?.results ?? []).map((row) => ({
    uuid: row.uuid,
    text: row.text,
    tags: safeTags(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function safeTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeAcceptedTags(raw: string[]): string[] {
  let tags = raw.map((tag) => tag.toLowerCase().trim()).filter(Boolean).filter((tag) => tag !== '1');
  tags = foldSequence(tags, ['things', 'to', 'learn'], ['to-learn']);
  tags = foldSequence(tags, ['physics', 'to', 'learn'], ['physics', 'to-learn']);
  tags = foldSequence(tags, ['hot', 'take'], ['hot-take']);
  const aliases: Record<string, string> = {
    questions: 'question',
    mental: 'mental-model',
    gpt: 'ai',
    watchlist: 'watch-list',
    contact: 'people',
  };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags.map((tag) => aliases[tag] ?? tag)) {
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function foldSequence(tokens: string[], from: string[], to: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const slice = tokens.slice(i, i + from.length);
    if (slice.length === from.length && slice.every((token, index) => token === from[index])) {
      out.push(...to);
      i += from.length;
      continue;
    }
    out.push(tokens[i]!);
    i += 1;
  }
  return out;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number, digits = 4): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

async function embedGoldQueries(queries: GoldQuery[]): Promise<{
  queryVectors: Map<string, Float32Array>;
  noteVectors: Map<string, Float32Array>;
}> {
  const extractor = await pipeline('feature-extraction', EMBED_MODEL);
  const queryVectors = new Map<string, Float32Array>();
  const noteVectors = new Map<string, Float32Array>();

  for (const query of queries) {
    const queryText = `${query.text}\n${query.tags.map((tag) => `#${tag}`).join(' ')}`.trim();
    const noteText = `${query.note.text}\n${query.note.tags.map((tag) => `#${tag}`).join(' ')}`.trim();
    const queryOut = await extractor(queryText.slice(0, 2000), { pooling: 'mean', normalize: true });
    const noteOut = await extractor(noteText.slice(0, 2000), { pooling: 'mean', normalize: true });
    queryVectors.set(query.uuid, new Float32Array(queryOut.data as Float32Array));
    noteVectors.set(query.uuid, new Float32Array(noteOut.data as Float32Array));
  }

  return { queryVectors, noteVectors };
}

async function main() {
  const notes = fetchRows();
  const gold = readJsonl<GoldRow>(GOLD_PATH).map((row) => ({
    ...row,
    tags: normalizeAcceptedTags(row.accepted_tags),
    note: {
      uuid: row.uuid,
      text: row.text,
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    },
  }));

  const strictCorpus = buildSimilarCorpus(gold.map((query) => query.note));
  const fullCorpus = buildSimilarCorpus(notes);

  const strictRelevantByUuid = new Map<string, Set<string>>();
  for (const query of gold) {
    const relevant = new Set<string>();
    for (const candidate of gold) {
      if (candidate.uuid === query.uuid) continue;
      if (query.tags.some((tag) => candidate.tags.includes(tag))) relevant.add(candidate.uuid);
    }
    if (relevant.size > 0) strictRelevantByUuid.set(query.uuid, relevant);
  }

  const proxyRelevantByUuid = new Map<string, Set<string>>();
  for (const query of gold) {
    const queryTags = new Set(query.tags);
    const relevant = new Set<string>();
    for (const candidate of notes) {
      if (candidate.uuid === query.uuid) continue;
      if (candidate.tags.some((tag) => queryTags.has(tag.toLowerCase()))) relevant.add(candidate.uuid);
    }
    if (relevant.size > 0) proxyRelevantByUuid.set(query.uuid, relevant);
  }

  const embeddings = await embedGoldQueries(gold);

  const strictSummaries = STRICT_METHODS.map((method) => {
    if (method === 'embedding_cosine' || method === 'embedding_hybrid') {
      return evaluateEmbeddingMethod(method, gold, strictRelevantByUuid, embeddings, strictCorpus);
    }
    return evaluateLexicalMethod(method, strictCorpus, gold, strictRelevantByUuid);
  }).sort((a, b) => b.mrrAt10 - a.mrrAt10 || b.recallAt10 - a.recallAt10 || b.hitAt1 - a.hitAt1 || a.method.localeCompare(b.method));

  const proxySummaries = SIMILAR_RETRIEVAL_METHODS.map((method) =>
    evaluateLexicalMethod(method, fullCorpus, gold, proxyRelevantByUuid),
  ).sort((a, b) => b.mrrAt10 - a.mrrAt10 || b.recallAt10 - a.recallAt10 || b.hitAt1 - a.hitAt1 || a.method.localeCompare(b.method));

  const strictWinner = strictSummaries[0];
  const proxyWinner = proxySummaries[0];
  if (!strictWinner || !proxyWinner) throw new Error('no retrieval methods evaluated');

  const liveStrict = strictSummaries.filter((summary): summary is MethodSummary<SimilarRetrievalMethod> =>
    SIMILAR_RETRIEVAL_METHODS.includes(summary.method as SimilarRetrievalMethod),
  );
  const strictLiveWinner = liveStrict[0];
  const recommendedLiveMethod = strictLiveWinner && (strictLiveWinner.mrrAt10 > 0 || strictLiveWinner.recallAt10 > 0)
    ? strictLiveWinner.method
    : proxyWinner.method;
  const recommendationBasis = strictLiveWinner && (strictLiveWinner.mrrAt10 > 0 || strictLiveWinner.recallAt10 > 0)
    ? 'strict gold-peer benchmark'
    : 'proxy full-corpus benchmark (strict live-safe methods were all zero)';

  const result: EvalResult = {
    source: REMOTE ? 'remote' : 'local',
    corpusSize: notes.length,
    goldenSize: gold.length,
    currentLiveMethod: BEST_SIMILAR_RETRIEVAL_METHOD,
    strictBenchmark: {
      description: 'gold queries vs gold candidate pool; relevance = shared accepted golden tags',
      queries: strictRelevantByUuid.size,
      winner: strictWinner.method,
      methods: strictSummaries,
    },
    proxyBenchmark: {
      description: 'gold queries vs full corpus; relevance = overlap between golden query tags and stored note.tags',
      queries: proxyRelevantByUuid.size,
      winner: proxyWinner.method,
      methods: proxySummaries,
    },
    recommendedLiveMethod,
    recommendationBasis,
  };

  writeFileSync(JSON_OUT, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(MD_OUT, renderMarkdown(result));
  process.stdout.write(renderMarkdown(result));
}

function evaluateLexicalMethod<M extends SimilarRetrievalMethod>(
  method: M,
  corpus: ReturnType<typeof buildSimilarCorpus>,
  queries: GoldQuery[],
  relevantByUuid: Map<string, Set<string>>,
): MethodSummary<M> {
  const rows: QueryResult[] = [];
  for (const query of queries) {
    const relevant = relevantByUuid.get(query.uuid);
    if (!relevant?.size) continue;
    const ranked = rankSimilarNotes(corpus, { text: query.text, tags: query.tags, excludeUuid: query.uuid }, method, 10);
    rows.push(scoreRanking(query.uuid, relevant, ranked.map((note) => note.uuid)));
  }
  return summarizeMethod(method, rows);
}

function evaluateEmbeddingMethod(
  method: 'embedding_cosine' | 'embedding_hybrid',
  queries: GoldQuery[],
  relevantByUuid: Map<string, Set<string>>,
  embeddings: { queryVectors: Map<string, Float32Array>; noteVectors: Map<string, Float32Array> },
  strictCorpus: ReturnType<typeof buildSimilarCorpus>,
): MethodSummary<'embedding_cosine' | 'embedding_hybrid'> {
  const overlapMaps = new Map<string, Map<string, number>>();
  if (method === 'embedding_hybrid') {
    for (const query of queries) {
      const ranked = rankSimilarNotes(strictCorpus, { text: query.text, tags: query.tags, excludeUuid: query.uuid }, 'overlap', strictCorpus.notes.length);
      overlapMaps.set(query.uuid, new Map(ranked.map((note) => [note.uuid, note.score])));
    }
  }

  const rows: QueryResult[] = [];
  for (const query of queries) {
    const relevant = relevantByUuid.get(query.uuid);
    if (!relevant?.size) continue;
    const queryVec = embeddings.queryVectors.get(query.uuid);
    if (!queryVec) continue;
    const overlapScores = overlapMaps.get(query.uuid) ?? new Map<string, number>();
    const ranked = queries
      .filter((candidate) => candidate.uuid !== query.uuid)
      .map((candidate) => {
        const noteVec = embeddings.noteVectors.get(candidate.uuid);
        if (!noteVec) return null;
        const cosine = dot(queryVec, noteVec);
        const overlap = overlapScores.get(candidate.uuid) ?? 0;
        const score = method === 'embedding_cosine'
          ? cosine
          : cosine * 0.8 + Math.tanh(overlap / 8) * 0.2;
        return { uuid: candidate.uuid, score };
      })
      .filter((candidate): candidate is { uuid: string; score: number } => !!candidate)
      .sort((a, b) => b.score - a.score || a.uuid.localeCompare(b.uuid))
      .slice(0, 10)
      .map((candidate) => candidate.uuid);
    rows.push(scoreRanking(query.uuid, relevant, ranked));
  }
  return summarizeMethod(method, rows);
}

function scoreRanking(uuid: string, relevant: Set<string>, top10: string[]): QueryResult {
  let found = 0;
  let firstRelevantRank: number | null = null;
  for (let i = 0; i < top10.length; i++) {
    if (!relevant.has(top10[i]!)) continue;
    found += 1;
    if (firstRelevantRank == null) firstRelevantRank = i + 1;
  }
  return {
    uuid,
    relevantTotal: relevant.size,
    recallAt10: found / relevant.size,
    hitAt1: firstRelevantRank === 1,
    hitAt3: firstRelevantRank != null && firstRelevantRank <= 3,
    reciprocalRank: firstRelevantRank == null ? 0 : 1 / firstRelevantRank,
    firstRelevantRank,
    top10,
  };
}

function summarizeMethod<M extends string>(method: M, rows: QueryResult[]): MethodSummary<M> {
  const failures = rows
    .filter((row) => row.firstRelevantRank == null)
    .slice(0, 5)
    .map((row) => ({ uuid: row.uuid, relevantTotal: row.relevantTotal, top10: row.top10 }));
  return {
    method,
    queries: rows.length,
    recallAt10: round(mean(rows.map((row) => row.recallAt10))),
    mrrAt10: round(mean(rows.map((row) => row.reciprocalRank))),
    hitAt1: round(mean(rows.map((row) => (row.hitAt1 ? 1 : 0)))),
    hitAt3: round(mean(rows.map((row) => (row.hitAt3 ? 1 : 0)))),
    meanRelevant: round(mean(rows.map((row) => row.relevantTotal))),
    failures,
  };
}

function dot(a: Float32Array, b: Float32Array): number {
  let out = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) out += (a[i] ?? 0) * (b[i] ?? 0);
  return out;
}

function renderMarkdown(result: EvalResult): string {
  const lines: string[] = [];
  lines.push('# Similar-notes retrieval eval');
  lines.push('');
  lines.push(`- Corpus: **${result.corpusSize}** notes (${result.source})`);
  lines.push(`- Golden notes available: **${result.goldenSize}**`);
  lines.push(`- Current live deterministic method: **${result.currentLiveMethod}**`);
  lines.push(`- Strict winner: **${result.strictBenchmark.winner}**`);
  lines.push(`- Proxy winner: **${result.proxyBenchmark.winner}**`);
  lines.push(`- Recommended live method: **${result.recommendedLiveMethod}** (${result.recommendationBasis})`);
  lines.push('');
  lines.push(`## Strict benchmark`);
  lines.push(result.strictBenchmark.description);
  lines.push('');
  lines.push(`Queries: **${result.strictBenchmark.queries}**`);
  lines.push('');
  lines.push('| Rank | Method | recall@10 | MRR@10 | hit@1 | hit@3 | mean relevant |');
  lines.push('|---:|---|---:|---:|---:|---:|---:|');
  result.strictBenchmark.methods.forEach((method, index) => {
    lines.push(`| ${index + 1} | ${method.method} | ${method.recallAt10.toFixed(4)} | ${method.mrrAt10.toFixed(4)} | ${method.hitAt1.toFixed(4)} | ${method.hitAt3.toFixed(4)} | ${method.meanRelevant.toFixed(2)} |`);
  });
  lines.push('');
  lines.push(`## Proxy benchmark`);
  lines.push(result.proxyBenchmark.description);
  lines.push('');
  lines.push(`Queries: **${result.proxyBenchmark.queries}**`);
  lines.push('');
  lines.push('| Rank | Method | recall@10 | MRR@10 | hit@1 | hit@3 | mean relevant |');
  lines.push('|---:|---|---:|---:|---:|---:|---:|');
  result.proxyBenchmark.methods.forEach((method, index) => {
    lines.push(`| ${index + 1} | ${method.method} | ${method.recallAt10.toFixed(4)} | ${method.mrrAt10.toFixed(4)} | ${method.hitAt1.toFixed(4)} | ${method.hitAt3.toFixed(4)} | ${method.meanRelevant.toFixed(2)} |`);
  });
  return `${lines.join('\n')}\n`;
}

await main();

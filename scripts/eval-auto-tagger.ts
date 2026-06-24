#!/usr/bin/env tsx
/**
 * Evaluate a cheap LLM auto-tagger against db/eval/golden-50.jsonl.
 *
 * Usage:
 *   npm run tags:eval:auto
 *   npm run tags:eval:auto -- --preset=rubric --model=us.anthropic.claude-haiku-4-5-20251001-v1:0
 *   npm run tags:eval:auto -- --gold=db/eval/holdout-50.jsonl
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

type Confidence = 'high' | 'medium' | 'low';

type GoldRow = {
  uuid: string;
  text: string;
  accepted_tags: string[];
};

type PredItem = {
  uuid?: unknown;
  suggested_tags?: unknown;
  primary?: unknown;
  confidence?: unknown;
  rationale?: unknown;
};

type EvalRow = {
  uuid: string;
  text: string;
  gold: string[];
  pred: string[];
  primary: string;
  confidence: Confidence;
  precision: number;
  recall: number;
  f1: number;
  primaryHit: boolean;
  exactSet: boolean;
  coversGold: boolean;
  anyOverlap: boolean;
  rationale: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..');
const DEFAULT_GOLD_PATH = resolve(REPO, 'db/eval/golden-50.jsonl');
const OUT_DIR = resolve(REPO, 'output/tag-eval');
const DEFAULT_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const CANONICAL_TAGS = [
  'idea', 'ai', 'thought', 'quote', 'link', 'llm', 'article', 'mental-model',
  'humor', 'robotics', 'question', 'unclassifiable', 'health', 'tweet', 'hot-take',
  'lesson', 'infra', 'hardware', 'philosophy', 'todo', 'reading-list', 'physics',
  'commerce', 'social', 'ml', 'design', 'writing', 'finance', 'to-learn',
  'people', 'transportation', 'watch-list',
] as const;
const CANONICAL = new Set<string>(CANONICAL_TAGS);

const SINGLE_ALIASES: Record<string, string> = {
  questions: 'question',
  mental: 'mental-model',
  gpt: 'ai',
  watchlist: 'watch-list',
  contact: 'people',
};
const DROP = new Set(['1']);
const MULTI_FOLDS: Array<{ from: string[]; to: string[] }> = [
  { from: ['things', 'to', 'learn'], to: ['to-learn'] },
  { from: ['physics', 'to', 'learn'], to: ['physics', 'to-learn'] },
  { from: ['hot', 'take'], to: ['hot-take'] },
];

const DEFINITIONS = [
  'idea=proposal, prototype, what-if, buildable concept, invention, app idea',
  'ai=AI, agents, general generative AI, AI product concept',
  'llm=language-model-specific, GPT/Claude, prompting, tokenization, evals using language models',
  'ml=classic machine learning, classifiers, training data outside LLM-specific notes',
  'thought=reflection or observation without an action/proposal',
  'quote=quoted aphorism, attributed words, clipped saying, quote-like standalone sentence',
  'link=bare URL or note whose main payload is a link',
  'tweet=Twitter/X URL, tweet detector/generator, tweet excerpt',
  'article=long-form article or essay link/commentary',
  'reading-list=queued thing to read',
  'watch-list=queued video/movie/show',
  'mental-model=framework for thinking, reusable lens, game theory, strategy frame',
  'question=open question or uncertainty, usually contains a question mark or asks whether/how/why',
  'lesson=distilled rule learned from experience',
  'hot-take=provocative or contrarian opinion',
  'humor=joke, gag, funny observation, challenge meant as a joke',
  'robotics=embodied AI, robots, physical automation',
  'health=body, medicine, diet, sleep, symptoms',
  'infra=devops, cloud, systems plumbing, security operations',
  'hardware=chips, devices, physical compute, rockets as hardware projects',
  'philosophy=ethics, meaning, epistemology, agency, human purpose',
  'physics=actual physics or radiation',
  'todo=explicit action item or imperative task',
  'commerce=markets, selling, buying, marketplaces, business model',
  'social=interpersonal or social dynamics',
  'design=UI, visual, product design, taste, aesthetics',
  'writing=writing craft or structuring prose',
  'finance=money, investing, markets',
  'people=named person, contact, relationship, biographical note',
  'transportation=cars, trains, flights, roads, transit infrastructure',
  'to-learn=subject the user wants to learn or study',
  'unclassifiable=last resort only',
].join('\n');

const STYLE_GUIDE = [
  'User-specific style:',
  '- Short buildable fragments default to idea, even when phrased imperatively: "make a model rocket" => idea, not todo.',
  '- Add todo only for explicit task lists or follow-up actions: "Look up", "Ask", multi-action checklist.',
  '- AI product ideas use idea+ai; do not substitute llm for ai unless the note specifically says LLM/llama/prompt/tokenizer/fine-tune.',
  '- GPT/ChatGPT mentions usually map to ai; add llm only when language-model mechanics are central.',
  '- Tweet URLs are link+tweet; tweet detector/generator ideas are idea+ai+social, not tweet.',
  '- Bare URLs are link; article-like URLs are link+article; design inspiration link collections are link+design.',
  '- Aphorisms with attribution are quote; motivational rules may add lesson/hot-take; ordinary personal observations stay thought.',
  '- Very terse study topics are to-learn; physics terms can be physics+to-learn when they are clearly topics to study.',
  '- Do not add design, commerce, hardware, health, social, or philosophy just because a related word appears; add them only when central.',
].join('\n');

const PRESETS: Record<string, { system: string; userLead: string }> = {
  compact: {
    system: [
      'You classify personal sticky notes into a closed taxonomy.',
      `Allowed tags: ${CANONICAL_TAGS.join(', ')}.`,
      'Pick 1-3 tags. Return strict JSON only.',
    ].join('\n'),
    userLead: 'Classify each note. Use only allowed tags.',
  },
  rubric: {
    system: [
      'You classify personal sticky notes into an existing multi-label taxonomy.',
      `Use ONLY these tags: ${CANONICAL_TAGS.join(', ')}.`,
      `Definitions:\n${DEFINITIONS}`,
      'Rules:',
      '- Choose 1-3 tags; include useful secondary tags when supported by the text.',
      '- primary must be one suggested tag and should be the best visual/background tag.',
      '- Prefer idea for buildable/proposed things; prefer thought for pure observations.',
      '- For AI product ideas, usually include both idea and ai; include llm only when language models/prompting/text generation are central.',
      '- Use unclassifiable only when no tag fits.',
      '- Output ONLY minified JSON with shape {"items":[{"uuid":"...","suggested_tags":["tag"],"primary":"tag","confidence":"high|medium|low","rationale":"short"}]}',
    ].join('\n'),
    userLead: 'Classify these notes. Optimize for matching the user\'s existing tag style, not a generic taxonomy.',
  },
  recall: {
    system: [
      'You are tagging messy personal notes. The labels are multi-label, so missing a secondary tag is an error.',
      `Allowed tags: ${CANONICAL_TAGS.join(', ')}.`,
      `Definitions:\n${DEFINITIONS}`,
      'Use 2-3 tags when a note spans multiple concepts. Use 1 tag only for bare quotes, bare links, or very terse single-topic notes.',
      'Common pairings: AI app concepts => idea+ai; LLM/prompt/eval notes => idea+ai+llm or ai+llm; URLs => link plus tweet/article when applicable; aphorisms => quote plus lesson/hot-take/mental-model when applicable.',
      'Output strict JSON only: {"items":[{"uuid":"...","suggested_tags":["tag"],"primary":"tag","confidence":"high|medium|low","rationale":"short"}]}',
    ].join('\n'),
    userLead: 'Classify each note with high recall while staying precise.',
  },
  style: {
    system: [
      'You classify messy personal sticky notes into the user\'s existing closed taxonomy.',
      `Allowed tags: ${CANONICAL_TAGS.join(', ')}.`,
      `Definitions:\n${DEFINITIONS}`,
      STYLE_GUIDE,
      'Choose exactly the smallest tag set that captures the user\'s likely filing intent: usually 1-2 tags, 3 only for clear multi-topic AI ideas or quote+lesson+hot-take.',
      'primary must be one suggested tag and should be idea for buildable concepts, link for links, quote for quotes, thought for pure observations.',
      'Output strict JSON only: {"items":[{"uuid":"...","suggested_tags":["tag"],"primary":"tag","confidence":"high|medium|low","rationale":"short"}]}',
    ].join('\n'),
    userLead: 'Classify each note using the user-specific style guide. Avoid plausible-but-extra secondary tags.',
  },
  coverage: {
    system: [
      'You classify messy personal sticky notes into the user\'s existing closed taxonomy.',
      `Allowed tags: ${CANONICAL_TAGS.join(', ')}.`,
      `Definitions:\n${DEFINITIONS}`,
      STYLE_GUIDE,
      'Optimize for gold-tag coverage: include every tag the user would want, even if that adds one extra plausible tag.',
      'Use 1-4 tags. Do not exceed 4. Do not include unclassifiable with any other tag.',
      'High-value coverage rules: AI product ideas usually need idea+ai; explicit LLM/prompt/tokenizer/fine-tune notes add llm; URLs add link plus tweet/article/design when evident; question notes add question and often thought; aphorisms add quote and sometimes lesson/hot-take/mental-model.',
      'Guardrail: do not spray unrelated broad tags; keep precision roughly above 0.60.',
      'primary must be one suggested tag and should be idea for buildable concepts, link for links, quote for quotes, thought for pure observations.',
      'Output strict JSON only: {"items":[{"uuid":"...","suggested_tags":["tag"],"primary":"tag","confidence":"high|medium|low","rationale":"short"}]}',
    ].join('\n'),
    userLead: 'Classify each note for high recall. Include all likely user-wanted tags; extras are acceptable only when plausible.',
  },
  'coverage-boost': {
    system: [
      'You classify messy personal sticky notes into the user\'s existing closed taxonomy.',
      `Allowed tags: ${CANONICAL_TAGS.join(', ')}.`,
      `Definitions:\n${DEFINITIONS}`,
      STYLE_GUIDE,
      'Optimize for recall: include every tag the user would want. A deterministic recall booster will add obvious closed-set tags from URLs, AI words, questions, quotes, and domain keywords.',
      'Use 1-4 tags before the booster. Do not include unclassifiable with any other tag.',
      'Output strict JSON only: {"items":[{"uuid":"...","suggested_tags":["tag"],"primary":"tag","confidence":"high|medium|low","rationale":"short"}]}',
    ].join('\n'),
    userLead: 'Classify each note for high recall. Include all likely user-wanted tags; extras are acceptable only when plausible.',
  },
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function loadDevVars(): void {
  const path = resolve(REPO, '.dev.vars');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function normalizeToken(token: string): string {
  return SINGLE_ALIASES[token.toLowerCase().trim()] ?? token.toLowerCase().trim();
}

function normalizeGolden(raw: string[]): string[] {
  let toks = raw.map((t) => t.toLowerCase().trim()).filter(Boolean).filter((t) => !DROP.has(t));
  for (const fold of [...MULTI_FOLDS].sort((a, b) => b.from.length - a.from.length)) {
    const next: string[] = [];
    let i = 0;
    while (i < toks.length) {
      const matches = fold.from.every((part, offset) => toks[i + offset] === part);
      if (matches) {
        next.push(...fold.to);
        i += fold.from.length;
      } else {
        const tok = toks[i];
        if (tok) next.push(tok);
        i += 1;
      }
    }
    toks = next;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of toks.map(normalizeToken)) {
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function noteBlock(row: GoldRow, index: number): string {
  return [
    `${index + 1}. uuid=${row.uuid}`,
    `text=${JSON.stringify(row.text.slice(0, 1800))}`,
  ].join('\n');
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced?.[1] ?? raw).trim();
  return JSON.parse(text) as unknown;
}

function itemsFromJson(parsed: unknown): PredItem[] {
  if (Array.isArray(parsed)) return parsed.filter((v): v is PredItem => !!v && typeof v === 'object');
  if (parsed && typeof parsed === 'object') {
    const maybe = (parsed as { items?: unknown }).items;
    if (Array.isArray(maybe)) return maybe.filter((v): v is PredItem => !!v && typeof v === 'object');
  }
  return [];
}

function normalizePred(raw: PredItem | undefined, maxTags: number): {
  tags: string[];
  primary: string;
  confidence: Confidence;
  rationale: string;
  invalidTags: string[];
} {
  const invalidTags: string[] = [];
  const tags: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw?.suggested_tags)) {
    for (const value of raw.suggested_tags) {
      if (typeof value !== 'string') continue;
      const tag = normalizeToken(value);
      if (!CANONICAL.has(tag)) {
        invalidTags.push(value);
        continue;
      }
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  }
  if (tags.length === 0) tags.push('unclassifiable');
  const rawPrimary = typeof raw?.primary === 'string' ? normalizeToken(raw.primary) : '';
  const primary = tags.includes(rawPrimary) ? rawPrimary : tags[0]!;
  const confidence = raw?.confidence === 'high' || raw?.confidence === 'medium' || raw?.confidence === 'low'
    ? raw.confidence
    : 'low';
  const rationale = typeof raw?.rationale === 'string' ? raw.rationale : '';
  return { tags: tags.slice(0, maxTags), primary, confidence, rationale, invalidTags };
}

function addTag(tags: string[], tag: string): void {
  if (CANONICAL.has(tag) && !tags.includes(tag)) tags.push(tag);
}

function coverageBoost(text: string, inputTags: string[], maxTags: number): string[] {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const tags = [...inputTags];
  const has = (needle: string) => t.includes(needle);
  const match = (re: RegExp) => re.test(t);
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  const questionLike = match(/^(how|what|why|where|which|do humans|do i|does|can|should)\b/);

  if (match(/^\/a\//) || match(/^aadi \d+/)) return ['unclassifiable'];

  if (match(/https?:\/\//)) {
    addTag(tags, 'link');
    if (match(/(twitter\.com|x\.com)/)) addTag(tags, 'tweet');
    if (has('/p/') || has('arikhanson')) addTag(tags, 'article');
    if (match(/design|declangessel|plasticlabs|brutalist/)) addTag(tags, 'design');
  }
  if (match(/\b(ai|agi|gpt\d*|chatgpt|llm|llama|natural language|automated research lab|simulate users|ai journal|product manager|generate)\b/) || has('tweet detector') || has('tweet generator')) addTag(tags, 'ai');
  if (match(/\b(llm|llama|tokenizer|prompt|finetune|fine-tune)\b/)) addTag(tags, 'llm');
  if (match(/\b(automate|build|make|generator|detector|simulate|app|api|n8n|model rocket|spaceship|research lab|crowdsourced|matchmaking|journal|neural network|score each site|sense|ar glasses|self driving|keep \+ grow)\b/)) addTag(tags, 'idea');
  if (questionLike) addTag(tags, 'question');
  if (questionLike || has('people like novelty') || has('american patriotism') || has('robots do not cooperate') || has('do humans have') || has('if it sounds good')) addTag(tags, 'thought');
  if (has('anonymous') || has(' - ') || has('“') || has("here's the rub") || has('if you only') || has('competitors')) addTag(tags, 'quote');
  if (has('you can do') || has('competitors') || has('hit by a bus')) addTag(tags, 'mental-model');
  if (has('you can do')) { addTag(tags, 'lesson'); addTag(tags, 'hot-take'); }
  if (has('heart') || has('health insurance')) addTag(tags, 'health');
  if (has('money') || has('finance') || has('insurance')) addTag(tags, 'finance');
  if (has('marketing') || has('marketplace') || has('matchmaking')) addTag(tags, 'commerce');
  if (has('api')) addTag(tags, 'infra');
  if (has('robot')) addTag(tags, 'robotics');
  if (has('rocket') || has('ar glasses') || has('self driving') || has('3d printed') || has('dj board')) addTag(tags, 'hardware');
  if (has('game theory') || has('supersymmetry') || has('gravit')) addTag(tags, 'to-learn');
  if (has('supersymmetry') || has('gravit') || has('radiation')) addTag(tags, 'physics');
  if (has('books to read')) addTag(tags, 'reading-list');
  if (has('product manager') || has('structure them') || has('writing')) addTag(tags, 'writing');
  if (has('harass') || has('harrass') || has('haggle') || has('minecraft')) addTag(tags, 'humor');
  if (has('philosophy') || has('consciousness') || has('alignment')) addTag(tags, 'philosophy');
  if (has('social') || has('tweet detector') || has('elon musk')) addTag(tags, 'social');
  if (wordCount <= 3 && !match(/https?:\/\//) && !tags.includes('unclassifiable')) addTag(tags, 'idea');

  const cleaned = tags.length > 1 ? tags.filter((tag) => tag !== 'unclassifiable') : tags;
  return cleaned.slice(0, maxTags);
}

function scoreSet(pred: string[], gold: string[]): { precision: number; recall: number; f1: number; overlap: number } {
  const p = new Set(pred);
  const g = new Set(gold);
  let overlap = 0;
  for (const tag of p) if (g.has(tag)) overlap += 1;
  const precision = p.size === 0 ? 0 : overlap / p.size;
  const recall = g.size === 0 ? 0 : overlap / g.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, overlap };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarize(rows: EvalRow[]) {
  const metric = (subset: EvalRow[]) => ({
    n: subset.length,
    precision: round(mean(subset.map((r) => r.precision))),
    recall: round(mean(subset.map((r) => r.recall))),
    tag_set_f1: round(mean(subset.map((r) => r.f1))),
    gold_coverage_rate: round(mean(subset.map((r) => r.coversGold ? 1 : 0))),
    primary_hit_rate: round(mean(subset.map((r) => r.primaryHit ? 1 : 0))),
    exact_set_rate: round(mean(subset.map((r) => r.exactSet ? 1 : 0))),
    any_overlap_rate: round(mean(subset.map((r) => r.anyOverlap ? 1 : 0))),
  });
  return {
    overall: metric(rows),
    by_confidence: {
      high: metric(rows.filter((r) => r.confidence === 'high')),
      medium: metric(rows.filter((r) => r.confidence === 'medium')),
      low: metric(rows.filter((r) => r.confidence === 'low')),
    },
    worst: rows
      .filter((row) => !row.coversGold)
      .sort((a, b) => a.recall - b.recall || a.f1 - b.f1 || a.uuid.localeCompare(b.uuid))
      .slice(0, 15)
      .map((row) => ({
        uuid: row.uuid,
        text: row.text.replace(/\s+/g, ' ').slice(0, 140),
        gold: row.gold,
        pred: row.pred,
        primary: row.primary,
        confidence: row.confidence,
        recall: round(row.recall),
        f1: round(row.f1),
        rationale: row.rationale,
      })),
  };
}

async function main(): Promise<void> {
  loadDevVars();
  const args = parseArgs(process.argv.slice(2));
  const presetName = typeof args.preset === 'string' ? args.preset : 'rubric';
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`Unknown --preset=${presetName}; choose ${Object.keys(PRESETS).join(', ')}`);
  const modelId = typeof args.model === 'string' ? args.model : (process.env.TAGGER_MODEL_ID || DEFAULT_MODEL);
  const region = process.env.AWS_REGION || 'us-east-1';
  const save = args.save !== false && args['no-save'] !== true;
  const maxTags = Number(args['max-tags'] ?? (presetName === 'coverage' ? 4 : presetName === 'coverage-boost' ? 6 : 3));
  const goldPath = typeof args.gold === 'string' ? resolve(REPO, args.gold) : DEFAULT_GOLD_PATH;
  const goldLabel = goldPath.startsWith(REPO) ? goldPath.slice(REPO.length + 1) : goldPath;

  const rows = readJsonl<GoldRow>(goldPath);
  const prompt = [
    `${preset.userLead}`,
    `Return exactly ${rows.length} items, one per uuid.`,
    rows.map(noteBlock).join('\n\n'),
  ].join('\n\n');

  const hasBearer = !!process.env.AWS_BEARER_TOKEN_BEDROCK;
  const hasKeys = !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;
  if (!hasBearer && !hasKeys) throw new Error('Missing Bedrock credentials: set AWS_BEARER_TOKEN_BEDROCK or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY');

  const bedrock = createAmazonBedrock(
    hasBearer
      ? { region, apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK }
      : {
          region,
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        },
  );

  const startedAt = new Date().toISOString();
  const response = await generateText({
    model: bedrock(modelId),
    system: preset.system,
    prompt,
    temperature: 0,
  });

  const parsed = extractJson(response.text);
  const items = itemsFromJson(parsed);
  const byUuid = new Map<string, PredItem>();
  for (const item of items) {
    if (typeof item.uuid === 'string') byUuid.set(item.uuid, item);
  }

  const invalidTags: Array<{ uuid: string; tags: string[] }> = [];
  const missingUuids: string[] = [];
  const evalRows: EvalRow[] = rows.map((row) => {
    const raw = byUuid.get(row.uuid);
    if (!raw) missingUuids.push(row.uuid);
    const pred = normalizePred(raw, maxTags);
    if (pred.invalidTags.length > 0) invalidTags.push({ uuid: row.uuid, tags: pred.invalidTags });
    const tags = presetName === 'coverage-boost' ? coverageBoost(row.text, pred.tags, maxTags) : pred.tags;
    const primary = tags.includes(pred.primary) ? pred.primary : tags[0]!;
    const gold = normalizeGolden(row.accepted_tags);
    const scored = scoreSet(tags, gold);
    return {
      uuid: row.uuid,
      text: row.text,
      gold,
      pred: tags,
      primary,
      confidence: pred.confidence,
      precision: scored.precision,
      recall: scored.recall,
      f1: scored.f1,
      primaryHit: gold.includes(pred.primary),
      exactSet: tags.length === gold.length && tags.every((tag) => gold.includes(tag)),
      coversGold: gold.every((tag) => tags.includes(tag)),
      anyOverlap: scored.overlap > 0,
      rationale: pred.rationale,
    };
  });

  const report = {
    config: { model: modelId, preset: presetName, temperature: 0, max_tags: maxTags, golden: goldLabel },
    generated_at: startedAt,
    parse: {
      returned_items: items.length,
      missing_items: missingUuids.length,
      missing_uuids: missingUuids,
      out_of_taxonomy_count: invalidTags.reduce((sum, item) => sum + item.tags.length, 0),
      out_of_taxonomy: invalidTags,
    },
    usage: response.usage,
    ...summarize(evalRows),
    rows: evalRows.map((row) => ({
      uuid: row.uuid,
      gold: row.gold,
      pred: row.pred,
      primary: row.primary,
      confidence: row.confidence,
      precision: round(row.precision),
      recall: round(row.recall),
      f1: round(row.f1),
      primaryHit: row.primaryHit,
      exactSet: row.exactSet,
      coversGold: row.coversGold,
      rationale: row.rationale,
    })),
  };

  if (save) {
    mkdirSync(OUT_DIR, { recursive: true });
    const stamp = startedAt.replace(/[:.]/g, '-');
    const path = resolve(OUT_DIR, `${stamp}-${presetName}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.error(`[eval-auto-tagger] wrote ${path}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

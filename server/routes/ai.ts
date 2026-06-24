// POST /api/ai/arrange  body { prompt, context? }
//
// Returns a list of `{uuid, x, y}` updates that the client applies
// optimistically then persists via POST /api/notes/positions.
//
// v1 (this file): deterministic intent-parser fallback. Recognizes a small
// vocabulary of arrangement verbs and operates over the current notes.
// When `env.AI` (Cloudflare AI Gateway / Workers AI) is wired, we route
// the prompt through the model with the move_notes tool schema; until then
// the deterministic path handles the documented prompt set from
// PLAN-whiteboard.md §6.
//
// Safety contract — enforced server-side regardless of source (LLM or
// deterministic):
//   - every uuid in `updates` must exist in notes (whitelist filter)
//   - every (x, y) is finite and clamped to ±1e6
//   - response shape is `{ updates: [{uuid, x, y}], explanation: string }`

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { desc } from 'drizzle-orm';
import { generateText, streamText, tool } from 'ai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { z } from 'zod';

import type { Env, Variables } from '../env';
import { db, schema } from '../../db/client';
import { arrangeBySemantic } from '../lib/semantic-layout';

/** SSE event envelope the client renders as toasts above the AI bar.
 *  Kept narrow on purpose — every event the server emits is one of these. */
export type AiArrangeEvent =
  | { type: 'status'; message: string }
  | { type: 'tool-call'; name: string; argsPreview: string }
  | { type: 'tool-result'; name: string; resultPreview: string }
  | { type: 'done'; updates: Update[]; explanation: string; strategy: string }
  | { type: 'error'; message: string };

/** Default Bedrock model id. Claude Sonnet 4.5 via the us-region inference
 *  profile — the on-demand throughput path for newer Claude models on
 *  Bedrock. Override per-deployment with the BEDROCK_MODEL_ID env var. */
const DEFAULT_BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const COORD_LIMIT = 1_000_000;
/** Cell size used by the layout heuristics; mirrors src/whiteboard/seed-layout.ts. */
const CELL_W = 280;
const CELL_H = 220;
const GAP = 24;

type Row = typeof schema.notes.$inferSelect;
type Update = { uuid: string; x: number; y: number };

export const aiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

aiRoutes.post('/arrange', async (c) => {
  const t0 = Date.now();
  let logPrompt = '';
  let logSelected: string[] | null = null;
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      prompt?: unknown;
      context?: { selectedUuids?: unknown; viewportBoardRect?: unknown } | null;
    };
    if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
      return c.json({ error: 'prompt required' }, 400);
    }
    const prompt = body.prompt.trim();
    logPrompt = prompt;
    const selectedUuids = Array.isArray(body.context?.selectedUuids)
      ? (body.context!.selectedUuids as unknown[]).filter((u): u is string => typeof u === 'string')
      : [];
    logSelected = selectedUuids.length > 0 ? selectedUuids : null;

    const rows = await db(c.env.DB).select().from(schema.notes).orderBy(desc(schema.notes.updatedAt)).all();

    // Deterministic-first: if the ladder regex matches a known strategy, run
    // it and skip Bedrock entirely. The LLM round-trip is reserved for prompts
    // none of the strategies recognise.
    let result: { updates: Update[]; explanation: string };
    let strategyLabel = '';
    const det = deriveStrategy(prompt);
    if (det !== 'unmatched') {
      result = arrangeDeterministic(prompt, rows, selectedUuids);
      strategyLabel = det;
    } else {
      const llm = await tryArrangeWithBedrock(c.env, prompt, rows, selectedUuids).catch((err) => {
        console.warn('[ai] bedrock arrange failed; falling back to deterministic', err);
        return null;
      });
      if (llm && llm.updates.length > 0) {
        result = llm;
        strategyLabel = 'bedrock';
      } else {
        result = arrangeDeterministic(prompt, rows, selectedUuids);
        strategyLabel = 'unmatched';
      }
    }
    // Whitelist filter — every returned uuid MUST exist in the corpus.
    const knownUuids = new Set(rows.map(r => r.uuid));
    const safe = result.updates
      .filter(u => knownUuids.has(u.uuid))
      .map(u => ({ uuid: u.uuid, x: clampCoord(u.x), y: clampCoord(u.y) }));

    // Fire-and-log: prompt logging never blocks the response. We swallow
    // errors here on purpose — a logging failure must not flip a successful
    // arrange into a 500. PLAN §11 Q4 "yes, append-only D1 table".
    void logArrange(c.env.DB, {
      prompt: logPrompt,
      strategy: strategyLabel,
      explanation: result.explanation,
      updatesCount: safe.length,
      affectedUuids: safe.slice(0, 64).map(u => u.uuid),
      selectedUuids: logSelected,
      status: safe.length > 0 ? 'ok' : 'empty',
      durationMs: Date.now() - t0,
    });

    return c.json({ updates: safe, explanation: result.explanation });
  } catch (err) {
    console.error('[ai] arrange failed (json)', err);
    void logArrange(c.env.DB, {
      prompt: logPrompt,
      strategy: 'error',
      explanation: '',
      updatesCount: 0,
      affectedUuids: [],
      selectedUuids: logSelected,
      status: 'error',
      errorDetail: String(err),
      durationMs: Date.now() - t0,
    });
    return c.json({ error: 'arrange failed', detail: String(err) }, 500);
  }
});

// POST /api/ai/arrange/stream  body { prompt, context? }
//
// Same contract as /arrange but streams progress events as SSE. Each event
// is one `AiArrangeEvent` JSON object. The final `done` event carries the
// same `{updates, explanation}` payload the JSON route returns. The client
// renders intermediate `status` / `tool-call` / `tool-result` events as
// slide-in/out toasts above the prompt bar.
aiRoutes.post('/arrange/stream', async (c) => {
  const t0 = Date.now();
  const body = (await c.req.json().catch(() => ({}))) as {
    prompt?: unknown;
    context?: { selectedUuids?: unknown } | null;
  };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return c.json({ error: 'prompt required' }, 400);
  const selectedUuids = Array.isArray(body.context?.selectedUuids)
    ? (body.context!.selectedUuids as unknown[]).filter((u): u is string => typeof u === 'string')
    : [];

  return streamSSE(c, async (stream) => {
    const emit = (ev: AiArrangeEvent) => stream.writeSSE({ data: JSON.stringify(ev) });

    try {
      await emit({ type: 'status', message: 'reading notes…' });
      const rows = await db(c.env.DB).select().from(schema.notes).orderBy(desc(schema.notes.updatedAt)).all();
      await emit({ type: 'status', message: `scanned ${rows.length} note${rows.length === 1 ? '' : 's'}` });

      const hasBedrock = !!(c.env.AWS_REGION && (c.env.AWS_BEARER_TOKEN_BEDROCK || (c.env.AWS_ACCESS_KEY_ID && c.env.AWS_SECRET_ACCESS_KEY)));
      let result: { updates: Update[]; explanation: string } | null = null;
      let strategy = '';

      // Deterministic-first: skip the model entirely when the prompt matches
      // a known strategy. Keeps "arrange by similarity" etc. instant.
      const det = deriveStrategy(prompt);
      if (det !== 'unmatched') {
        await emit({ type: 'status', message: `deterministic: ${det}` });
        result = arrangeDeterministic(prompt, rows, selectedUuids);
        strategy = det;
      } else if (hasBedrock) {
        const modelId = c.env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL;
        await emit({ type: 'status', message: `asking ${humanModel(modelId)}…` });
        result = await tryArrangeWithBedrockStreaming(c.env, prompt, rows, selectedUuids, emit).catch(async (err) => {
          console.warn('[ai] bedrock stream failed, falling back', err);
          await emit({ type: 'status', message: 'model error — using fallback' });
          return null;
        });
        if (result && result.updates.length > 0) strategy = 'bedrock';
      }

      if (!result || result.updates.length === 0) {
        await emit({ type: 'status', message: `deterministic fallback` });
        result = arrangeDeterministic(prompt, rows, selectedUuids);
        strategy = 'unmatched';
      }

      const known = new Set(rows.map(r => r.uuid));
      const safe = result.updates
        .filter(u => known.has(u.uuid))
        .map(u => ({ uuid: u.uuid, x: clampCoord(u.x), y: clampCoord(u.y) }));

      void logArrange(c.env.DB, {
        prompt,
        strategy,
        explanation: result.explanation,
        updatesCount: safe.length,
        affectedUuids: safe.slice(0, 64).map(u => u.uuid),
        selectedUuids: selectedUuids.length > 0 ? selectedUuids : null,
        status: safe.length > 0 ? 'ok' : 'empty',
        durationMs: Date.now() - t0,
      });

      await emit({ type: 'done', updates: safe, explanation: result.explanation, strategy });
    } catch (err) {
      console.error('[ai] stream arrange failed', err);
      await emit({ type: 'error', message: String(err instanceof Error ? err.message : err).slice(0, 200) });
    }
  });
});

function humanModel(id: string): string {
  // "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "claude sonnet 4.5"
  const m = id.match(/claude-([a-z]+)-([\d-]+)/);
  if (!m || !m[1] || !m[2]) return id;
  return `claude ${m[1]} ${m[2].replace(/-/g, '.').replace(/\.\d{8}.*/, '')}`;
}

/** Best-effort insert into ai_arrange_log. Catches every error silently —
 *  callers never await this so the route's response shape doesn't depend
 *  on the log table existing or being writable. */
async function logArrange(
  d1: D1Database,
  entry: {
    prompt: string;
    strategy: string;
    explanation: string;
    updatesCount: number;
    affectedUuids: string[];
    selectedUuids: string[] | null;
    status: 'ok' | 'empty' | 'error';
    errorDetail?: string;
    durationMs: number;
  },
): Promise<void> {
  try {
    await db(d1).insert(schema.aiArrangeLog).values({
      prompt: entry.prompt,
      strategy: entry.strategy,
      explanation: entry.explanation,
      updatesCount: entry.updatesCount,
      affectedUuids: JSON.stringify(entry.affectedUuids),
      selectedUuids: entry.selectedUuids ? JSON.stringify(entry.selectedUuids) : null,
      status: entry.status,
      errorDetail: entry.errorDetail ?? null,
      durationMs: entry.durationMs,
      createdAt: Date.now(),
    });
  } catch (err) {
    // Table may not exist yet (migration not applied) — swallow.
    console.warn('[ai] arrange log write failed', err);
  }
}

// Single source of truth for the strategy ladder — both arrangeDeterministic
// and deriveStrategy iterate this list in order, first match wins. Kept here
// to eliminate the drift hazard the previous "keep these two regex blocks in
// sync" comment apologised for. tag-to-corner is in the list but takes a
// different shape (needs `rows` to verify the tag actually exists), so it's
// handled as the tail in arrangeDeterministic and recognised separately in
// deriveStrategy.
type StrategyEntry = {
  name: string;
  match: (p: string) => boolean;
  run: (scope: Row[], rawPrompt: string) => { updates: Update[]; explanation: string };
};
const STRATEGY_LADDER: readonly StrategyEntry[] = [
  {
    name: 'semantic',
    // "arrange by similarity", "cluster by theme / topic / meaning",
    // "group related notes", "by content". Stays narrow so layout-y prompts
    // ("cluster by tag") still route to the literal-tag strategy below.
    match: p => /(similar|semantic|theme|topic|meaning|by content|related)/.test(p),
    run: (scope, raw) => arrangeBySemantic(scope, [], raw),
  },
  {
    name: 'cluster-by-tag',
    match: p => /(cluster|group|organize|organise).*\btag/.test(p) || /\bby tag\b/.test(p),
    run: (scope) => arrangeClusterByTag(scope),
  },
  {
    name: 'timeline',
    match: p => /(timeline|chronolog|by date|by time|sort by created)/.test(p),
    run: (scope) => arrangeTimeline(scope),
  },
  {
    name: 'ring',
    match: p => /(ring|circle|round)/.test(p),
    run: (scope) => arrangeRing(scope),
  },
  {
    name: 'scatter',
    match: p => /(scatter|spread|random)/.test(p),
    run: (scope, raw) => arrangeScatter(scope, raw),
  },
  {
    name: 'grid',
    match: p => /(grid|tidy|arrange|organize|organise|line up|align)/.test(p),
    run: (scope) => arrangeGrid(scope),
  },
];

/** Map a prompt to the strategy label arrangeDeterministic would pick.
 *  Derived from STRATEGY_LADDER — no parallel regex copy. */
function deriveStrategy(prompt: string): string {
  const p = prompt.toLowerCase();
  for (const s of STRATEGY_LADDER) if (s.match(p)) return s.name;
  // (semantic is in the ladder above; deriveStrategy picks it up there)
  if (/\b(move|put|place|send)\b/.test(p) && /#/.test(p)) return 'tag-to-corner';
  return 'unmatched';
}

function clampCoord(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n > COORD_LIMIT) return COORD_LIMIT;
  if (n < -COORD_LIMIT) return -COORD_LIMIT;
  return n;
}

// --- Deterministic intent parser ---
//
// Lightweight: lowercase + keyword match against an ordered ladder of
// strategies. First match wins. Each strategy returns full updates + a
// one-line explanation so the client can paint it as a toast.

export function arrangeDeterministic(
  prompt: string,
  rows: Row[],
  selectedUuids: string[],
): { updates: Update[]; explanation: string } {
  const p = prompt.toLowerCase();
  const scope = pickScope(rows, selectedUuids, p);

  for (const strategy of STRATEGY_LADDER) {
    if (strategy.match(p)) return strategy.run(scope, prompt);
  }

  // --- Move-tag-to-quadrant — "move all #idea to top-left". Handled outside
  //     STRATEGY_LADDER because it needs `rows` (not just the prompt) to
  //     decide if the named tag is actually present.
  const quadMatch = parseQuadrantMove(p, rows);
  if (quadMatch) return quadMatch;

  return {
    updates: [],
    explanation: `couldn't parse "${prompt}"; try "cluster by tag", "timeline", "ring", "grid", or "scatter"`,
  };
}

function pickScope(rows: Row[], selectedUuids: string[], prompt: string): Row[] {
  if (selectedUuids.length > 0 && /(selected|these|highlighted)/.test(prompt)) {
    const set = new Set(selectedUuids);
    return rows.filter(r => set.has(r.uuid));
  }
  return rows;
}

function parseTags(jsonStr: string): string[] {
  try {
    const v = JSON.parse(jsonStr) as unknown;
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function primaryTagOf(row: Row): string {
  const t = parseTags(row.tags);
  return t[0] ?? '';
}

// --- Strategies ---

/** Group notes by primary tag, lay each group out in its own block.
 *  Blocks stack left-to-right; within a block notes form a grid. */
function arrangeClusterByTag(rows: Row[]): { updates: Update[]; explanation: string } {
  if (rows.length === 0) return { updates: [], explanation: 'no notes to cluster' };
  const byTag = new Map<string, Row[]>();
  for (const r of rows) {
    const tag = primaryTagOf(r) || '(untagged)';
    const arr = byTag.get(tag) ?? [];
    arr.push(r);
    byTag.set(tag, arr);
  }
  // Stable order: by group size desc, then tag name asc.
  const groups = Array.from(byTag.entries()).sort((a, b) => {
    if (a[1].length !== b[1].length) return b[1].length - a[1].length;
    return a[0].localeCompare(b[0]);
  });

  const updates: Update[] = [];
  let cursorX = 0;
  for (const [, members] of groups) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    members.sort((a, b) => a.createdAt - b.createdAt);
    members.forEach((row, i) => {
      const col = i % cols;
      const r = Math.floor(i / cols);
      updates.push({
        uuid: row.uuid,
        x: cursorX + col * (CELL_W + GAP),
        y: r * (CELL_H + GAP),
      });
    });
    cursorX += cols * (CELL_W + GAP) + GAP * 3;  // extra gap between groups
  }
  return { updates, explanation: `clustered ${updates.length} notes into ${groups.length} groups by primary tag` };
}

/** Sort by createdAt asc, lay out in a single horizontal line on y=0. */
function arrangeTimeline(rows: Row[]): { updates: Update[]; explanation: string } {
  if (rows.length === 0) return { updates: [], explanation: 'no notes to line up' };
  const sorted = rows.slice().sort((a, b) => a.createdAt - b.createdAt);
  const updates: Update[] = sorted.map((row, i) => ({
    uuid: row.uuid,
    x: i * (CELL_W + GAP),
    y: 0,
  }));
  return { updates, explanation: `timeline of ${updates.length} notes, oldest at left` };
}

/** Lay notes around a ring centered at origin. Radius scales with count. */
function arrangeRing(rows: Row[]): { updates: Update[]; explanation: string } {
  if (rows.length === 0) return { updates: [], explanation: 'no notes to ring' };
  const n = rows.length;
  // Circumference must fit ~CELL_W * 1.2 per note as min arc length.
  const minSpacing = CELL_W * 1.2;
  const radius = Math.max(CELL_W * 1.6, (n * minSpacing) / (2 * Math.PI));
  const updates: Update[] = rows.map((row, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    return {
      uuid: row.uuid,
      x: radius * Math.cos(angle) - CELL_W / 2,
      y: radius * Math.sin(angle) - CELL_H / 2,
    };
  });
  return { updates, explanation: `${n} notes arranged in a ring (radius \u2248 ${Math.round(radius)}px)` };
}

/** Pseudo-random scatter within a deterministic box. Uses uuid-hash seeding
 *  so the same prompt produces the same scatter (no randomness server-side). */
function arrangeScatter(rows: Row[], rawPrompt: string): { updates: Update[]; explanation: string } {
  if (rows.length === 0) return { updates: [], explanation: 'no notes to scatter' };
  const span = Math.ceil(Math.sqrt(rows.length)) * (CELL_W + GAP) * 1.6;
  const updates: Update[] = rows.map((row) => {
    const h = hash32(row.uuid + '|' + rawPrompt);
    const u = (h & 0xffff) / 0xffff;
    const v = ((h >>> 16) & 0xffff) / 0xffff;
    return {
      uuid: row.uuid,
      x: (u - 0.5) * span,
      y: (v - 0.5) * span,
    };
  });
  return { updates, explanation: `scattered ${rows.length} notes across a ${Math.round(span)}px square` };
}

function arrangeGrid(rows: Row[]): { updates: Update[]; explanation: string } {
  if (rows.length === 0) return { updates: [], explanation: 'no notes to arrange' };
  const sorted = rows.slice().sort((a, b) => a.createdAt - b.createdAt);
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const updates: Update[] = sorted.map((row, i) => ({
    uuid: row.uuid,
    x: (i % cols) * (CELL_W + GAP),
    y: Math.floor(i / cols) * (CELL_H + GAP),
  }));
  return { updates, explanation: `arranged ${updates.length} notes in a ${cols}-column grid` };
}

/** Parse "move all #tag to <corner>" and place every matching note into that
 *  quadrant. Quadrant box origins (in board-space) are fixed offsets from 0,0. */
function parseQuadrantMove(prompt: string, rows: Row[]): { updates: Update[]; explanation: string } | null {
  // Verb gate first — don't accidentally match "cluster" or "timeline" prompts.
  if (!/\b(move|put|place|send)\b/.test(prompt)) return null;
  // Tag match REQUIRES the `#` prefix so the verb token ("move", "put", "send")
  // doesn't get picked up as the tag. The corpus uses inline `#hashtag`
  // conventions so this matches user mental model anyway.
  const tagMatch = prompt.match(/#([a-z0-9][a-z0-9-_]*)/i);
  const cornerMatch = prompt.match(/(top[\s-]*left|top[\s-]*right|bottom[\s-]*left|bottom[\s-]*right|left|right|top|bottom|center|centre)/);
  if (!tagMatch || !cornerMatch) return null;
  const tag = tagMatch[1]!.toLowerCase();
  const corner = cornerMatch[1]!.replace(/\s|-/g, '').toLowerCase();

  const matching = rows.filter(r => parseTags(r.tags).some(t => t.toLowerCase() === tag));
  if (matching.length === 0) return null;

  const offsets: Record<string, { x: number; y: number }> = {
    topleft:     { x: -2000, y: -1500 },
    topright:    { x:  1200, y: -1500 },
    bottomleft:  { x: -2000, y:  1200 },
    bottomright: { x:  1200, y:  1200 },
    left:        { x: -2000, y:     0 },
    right:       { x:  1200, y:     0 },
    top:         { x:     0, y: -1500 },
    bottom:      { x:     0, y:  1200 },
    center:      { x:     0, y:     0 },
    centre:      { x:     0, y:     0 },
  };
  const off = offsets[corner] ?? { x: 0, y: 0 };
  const cols = Math.max(1, Math.ceil(Math.sqrt(matching.length)));
  matching.sort((a, b) => a.createdAt - b.createdAt);
  const updates: Update[] = matching.map((row, i) => ({
    uuid: row.uuid,
    x: off.x + (i % cols) * (CELL_W + GAP),
    y: off.y + Math.floor(i / cols) * (CELL_H + GAP),
  }));
  return { updates, explanation: `moved ${matching.length} notes tagged #${tag} to ${corner.replace('centre','center')}` };
}

// --- Bedrock (Vercel AI SDK) path -------------------------------------------
//
// We give the model a single tool: `move_notes`, which takes a list of
// `{uuid, x, y}` updates. The model decides which notes to move and where;
// the server still whitelist-filters the uuids and clamps coordinates before
// echoing them back to the client. We pass it a compact summary of the
// corpus (uuid + first line of body + tags + current x/y) so it can reason
// about content without needing the full note text.

async function tryArrangeWithBedrock(
  env: Env,
  prompt: string,
  rows: Row[],
  selectedUuids: string[],
): Promise<{ updates: Update[]; explanation: string } | null> {
  const region = env.AWS_REGION;
  const hasBearer = !!env.AWS_BEARER_TOKEN_BEDROCK;
  const hasSigV4 = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  if (!region || (!hasBearer && !hasSigV4)) return null;
  if (rows.length === 0) return { updates: [], explanation: 'no notes to arrange' };

  // Bearer token takes precedence (skips SigV4). Falls back to IAM creds.
  const bedrock = createAmazonBedrock(
    hasBearer
      ? { region, apiKey: env.AWS_BEARER_TOKEN_BEDROCK }
      : {
          region,
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          sessionToken: env.AWS_SESSION_TOKEN,
        },
  );
  const modelId = env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL;

  // Compact notes summary. Keep it under a few hundred lines — we ship at most
  // 200 notes to bound prompt size. The deterministic ladder runs over the
  // full corpus anyway, so cropping here is fine.
  const cap = 200;
  const summary = rows.slice(0, cap).map((r) => ({
    uuid: r.uuid,
    title: firstLine(r.text).slice(0, 80),
    tags: parseTags(r.tags),
    x: r.positionX ?? null,
    y: r.positionY ?? null,
  }));
  const selectedSet = new Set(selectedUuids);

  let captured: { updates: Update[]; explanation: string } | null = null;
  const setCaptured = (v: { updates: Update[]; explanation: string }) => { captured = v; };

  const sys = [
    'You arrange sticky notes on an infinite 2D whiteboard.',
    `Cell size: ${CELL_W}x${CELL_H}px, gap ${GAP}px. Origin (0,0) is the visual center.`,
    'Read the user prompt and call the `move_notes` tool exactly once with a list of {uuid, x, y} positions for every note you want to move.',
    'You may move all notes, a subset, or only the selected ones. Do not invent uuids; only use uuids from the provided list.',
    'Pick coordinates that produce a tidy, non-overlapping layout. Coordinates are in board pixels and may be negative.',
    'Also pass a short one-sentence `explanation` describing what you did.',
  ].join('\n');

  const user = [
    `User prompt: ${prompt}`,
    selectedUuids.length > 0 ? `Selected uuids: ${selectedUuids.join(', ')}` : 'No notes selected.',
    `Notes (${summary.length}${rows.length > cap ? ` of ${rows.length}` : ''}):`,
    JSON.stringify(summary),
  ].join('\n\n');

  const moveNotesTool = tool({
    description: 'Apply a list of position updates to the whiteboard. Call this exactly once.',
    inputSchema: z.object({
      explanation: z.string().describe('One short sentence describing the arrangement.'),
      updates: z.array(z.object({
        uuid: z.string(),
        x: z.number(),
        y: z.number(),
      })).describe('Position updates to apply.'),
    }),
    execute: async (args) => {
      setCaptured({
        updates: args.updates.map(u => ({ uuid: u.uuid, x: u.x, y: u.y })),
        explanation: args.explanation,
      });
      return { ok: true, applied: args.updates.length };
    },
  });

  await generateText({
    model: bedrock(modelId),
    system: sys,
    prompt: user,
    tools: { move_notes: moveNotesTool },
    toolChoice: 'required',
    maxRetries: 1,
  });

  const result = captured as { updates: Update[]; explanation: string } | null;
  if (!result) return null;
  // Keep only selected notes if the user clearly scoped to a subset; the
  // server-side whitelist further enforces that uuids exist.
  if (selectedSet.size > 0 && /(selected|these|highlighted)/.test(prompt.toLowerCase())) {
    return {
      updates: result.updates.filter(u => selectedSet.has(u.uuid)),
      explanation: result.explanation,
    };
  }
  return result;
}

/** Streaming twin of tryArrangeWithBedrock. Same model, same tool, same
 *  prompt — but emits status / tool-call / tool-result events as the
 *  model decides what to do, so the UI can render its thought process. */
async function tryArrangeWithBedrockStreaming(
  env: Env,
  prompt: string,
  rows: Row[],
  selectedUuids: string[],
  emit: (ev: AiArrangeEvent) => Promise<void>,
): Promise<{ updates: Update[]; explanation: string } | null> {
  const region = env.AWS_REGION;
  const hasBearer = !!env.AWS_BEARER_TOKEN_BEDROCK;
  const hasSigV4 = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  if (!region || (!hasBearer && !hasSigV4)) return null;
  if (rows.length === 0) return { updates: [], explanation: 'no notes to arrange' };

  const bedrock = createAmazonBedrock(
    hasBearer
      ? { region, apiKey: env.AWS_BEARER_TOKEN_BEDROCK }
      : {
          region,
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          sessionToken: env.AWS_SESSION_TOKEN,
        },
  );
  const modelId = env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL;

  const cap = 200;
  const summary = rows.slice(0, cap).map((r) => ({
    uuid: r.uuid,
    title: firstLine(r.text).slice(0, 80),
    tags: parseTags(r.tags),
    x: r.positionX ?? null,
    y: r.positionY ?? null,
  }));
  const selectedSet = new Set(selectedUuids);

  let captured: { updates: Update[]; explanation: string } | null = null;
  const setCaptured = (v: { updates: Update[]; explanation: string }) => { captured = v; };

  const sys = [
    'You arrange sticky notes on an infinite 2D whiteboard.',
    `Cell size: ${CELL_W}x${CELL_H}px, gap ${GAP}px. Origin (0,0) is the visual center.`,
    'Read the user prompt and call the `move_notes` tool exactly once with a list of {uuid, x, y} positions for every note you want to move.',
    'You may move all notes, a subset, or only the selected ones. Do not invent uuids; only use uuids from the provided list.',
    'Pick coordinates that produce a tidy, non-overlapping layout. Coordinates are in board pixels and may be negative.',
    'Also pass a short one-sentence `explanation` describing what you did.',
  ].join('\n');
  const user = [
    `User prompt: ${prompt}`,
    selectedUuids.length > 0 ? `Selected uuids: ${selectedUuids.join(', ')}` : 'No notes selected.',
    `Notes (${summary.length}${rows.length > cap ? ` of ${rows.length}` : ''}):`,
    JSON.stringify(summary),
  ].join('\n\n');

  const moveNotesTool = tool({
    description: 'Apply a list of position updates to the whiteboard. Call this exactly once.',
    inputSchema: z.object({
      explanation: z.string(),
      updates: z.array(z.object({ uuid: z.string(), x: z.number(), y: z.number() })),
    }),
    execute: async (args) => {
      setCaptured({
        updates: args.updates.map(u => ({ uuid: u.uuid, x: u.x, y: u.y })),
        explanation: args.explanation,
      });
      return { ok: true, applied: args.updates.length };
    },
  });

  const stream = streamText({
    model: bedrock(modelId),
    system: sys,
    prompt: user,
    tools: { move_notes: moveNotesTool },
    toolChoice: 'required',
    maxRetries: 1,
  });

  // Iterate fullStream so we can surface tool-call lifecycle as the model
  // decides what to do. Each event is one toast in the UI.
  let sawTextDelta = false;
  for await (const part of stream.fullStream) {
    if (part.type === 'text-delta' && !sawTextDelta) {
      sawTextDelta = true;
      await emit({ type: 'status', message: 'model is thinking…' });
    } else if (part.type === 'tool-call') {
      // input is the parsed args; show a compact count preview.
      const input = (part.input ?? {}) as { updates?: unknown[]; explanation?: string };
      const n = Array.isArray(input.updates) ? input.updates.length : 0;
      await emit({
        type: 'tool-call',
        name: part.toolName,
        argsPreview: n > 0 ? `${n} note${n === 1 ? '' : 's'}` : '…',
      });
    } else if (part.type === 'tool-result') {
      const out = (part.output ?? {}) as { applied?: number };
      await emit({
        type: 'tool-result',
        name: part.toolName,
        resultPreview: typeof out.applied === 'number' ? `applied ${out.applied}` : 'done',
      });
    } else if (part.type === 'error') {
      throw part.error;
    }
  }
  // Final usage stats are available via `await stream.usage` if we ever want
  // to render token counts; skipped for now to keep events focused on actions.

  const final = captured as { updates: Update[]; explanation: string } | null;
  if (!final) return null;
  if (selectedSet.size > 0 && /(selected|these|highlighted)/.test(prompt.toLowerCase())) {
    return {
      updates: final.updates.filter(u => selectedSet.has(u.uuid)),
      explanation: final.explanation,
    };
  }
  return final;
}

function firstLine(body: string): string {
  const i = body.indexOf('\n');
  return (i >= 0 ? body.slice(0, i) : body).trim();
}

// --- 32-bit FNV-1a hash for deterministic pseudo-random placement ---

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { desc } from 'drizzle-orm';
import { generateText, streamText } from 'ai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

import type { Env, Variables } from '../env';
import { db, schema } from '../../db/client';
import { buildNoteInsert } from '../lib/note-write';
import { noteDisplayTitle, notePreviewText, noteSearchText } from '../../src/lib/link-note';

const DEFAULT_BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

export const NOTES_CHAT_SYSTEM_PROMPT = [
  'You are a thoughtful creative reasoning partner for the user\'s personal link library and ideas.',
  'Use the provided saved links as evidence; cite supporting links inline as [#1], [#2], etc.',
  'Do not invent facts beyond the saved links or the user\'s chat replies.',
  'Your job is to help the user think better, not just analyze what they already believe.',
  'Sometimes that means expanding the space of possibilities with multiple distinct angles, reframes, opposites, constraint flips, and adjacent ideas.',
  'Sometimes that means identifying assumptions, testing what is load-bearing, and asking focused follow-up questions.',
  'Do not be rigid about these behaviors; shift naturally between generative and analytical thinking based on what would be most useful in the moment.',
  'When the saved links are thin or only contain the user\'s question, say what is missing briefly, then ask 1-3 concrete follow-up questions to help the user think it through now.',
  'Be concise, specific, and conversational. Do not lecture or force structure when a lighter touch would help.',
  'Use the saved links when relevant, but do not get trapped in summarizing them.',
  'Do not end with "write a follow-up note" or a generic offer; continue the conversation.',
].join('\n');

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type SourceNote = {
  uuid: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourceDescription?: string | null;
  sourceSiteName?: string | null;
  sourceContentText?: string | null;
};
type ChatEvent =
  | { type: 'status'; message: string }
  | { type: 'sources'; notes: SourceNote[] }
  | { type: 'stdout'; text: string }
  | { type: 'done'; answer: string }
  | { type: 'error'; message: string };

export const chatRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const SUGGESTION_CACHE_MS = 10 * 60 * 1000;
const CHAT_CHUNK_CHARS = 1_200;
const CHAT_CHUNK_OVERLAP = 200;
const CHAT_MAX_CHUNKS_PER_NOTE = 80;
const suggestionCache = new Map<string, { expiresAt: number; questions: string[] }>();

chatRoutes.post('/stream', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    message?: unknown;
    history?: unknown;
    topK?: unknown;
  };
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return c.json({ error: 'message required' }, 400);
  const history = Array.isArray(body.history)
    ? body.history.filter(isChatMessage).slice(-8)
    : [];
  const topK = clampTopK(body.topK);

  return streamSSE(c, async (stream) => {
    const emit = (ev: ChatEvent) => stream.writeSSE({ data: JSON.stringify(ev) });
    try {
      await emit({ type: 'status', message: 'reading links…' });
      const rows = await db(c.env.DB)
        .select()
        .from(schema.notes)
        .orderBy(desc(schema.notes.updatedAt))
        .all();
      await emit({ type: 'status', message: `scanned ${rows.length} links` });

      const notes = rows.map((row) => ({
        uuid: row.uuid,
        text: row.text,
        tags: safeParseTags(row.tags),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        sourceUrl: row.sourceUrl,
        sourceTitle: row.sourceTitle,
        sourceDescription: row.sourceDescription,
        sourceSiteName: row.sourceSiteName,
        sourceContentText: row.sourceContentText,
      }));
      const sources = rankNotes(notes, [message, ...history.map((m) => m.content)], topK);
      await emit({ type: 'sources', notes: sources });

      const answer = await answerFromNotes(c.env, message, history, sources, (text) => emit({ type: 'stdout', text }));
      await emit({ type: 'done', answer });
    } catch (err) {
      console.error('[chat] stream failed', err);
      await emit({ type: 'error', message: String(err instanceof Error ? err.message : err).slice(0, 240) });
    }
  });
});

chatRoutes.get('/suggestions', async (c) => {
  return suggestionResponse(c, [], c.req.query('refresh') === '1');
});

chatRoutes.post('/suggestions', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { history?: unknown; refresh?: unknown };
  const history = Array.isArray(body.history) ? body.history.filter(isChatMessage).slice(-6) : [];
  return suggestionResponse(c, history, body.refresh === true);
});

chatRoutes.post('/save-note', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; tags?: unknown };
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return c.json({ error: 'text required' }, 400);
    }
    const note = buildNoteInsert(body.tags, body.text);
    await db(c.env.DB).insert(schema.notes).values(note);
    return c.json({ note }, 201);
  } catch (err) {
    console.error('[chat] save-note failed', err);
    return c.json({ error: 'save-note failed', detail: String(err) }, 500);
  }
});

async function suggestionResponse(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  history: ChatMessage[],
  refresh: boolean,
) {
  try {
    const rows = await db(c.env.DB)
      .select()
      .from(schema.notes)
      .orderBy(desc(schema.notes.updatedAt))
      .all();
    const notes = rows.slice(0, 24).map((row) => ({
      uuid: row.uuid,
      text: row.text,
      tags: safeParseTags(row.tags),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sourceUrl: row.sourceUrl,
      sourceTitle: row.sourceTitle,
      sourceDescription: row.sourceDescription,
      sourceSiteName: row.sourceSiteName,
      sourceContentText: row.sourceContentText,
    }));
    const key = suggestionCacheKey(notes, history);
    const cached = suggestionCache.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now()) return c.json({ questions: cached.questions });
    const questions = await suggestQuestions(c.env, notes, history);
    suggestionCache.set(key, { questions, expiresAt: Date.now() + SUGGESTION_CACHE_MS });
    while (suggestionCache.size > 32) suggestionCache.delete(suggestionCache.keys().next().value as string);
    return c.json({ questions });
  } catch (err) {
    console.error('[chat] suggestions failed', err);
    return c.json({ questions: fallbackSuggestedQuestions([], history) });
  }
}

function isChatMessage(v: unknown): v is ChatMessage {
  return !!v && typeof v === 'object'
    && (((v as ChatMessage).role === 'user') || ((v as ChatMessage).role === 'assistant'))
    && typeof (v as ChatMessage).content === 'string';
}

function clampTopK(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 6;
  return Math.max(1, Math.min(12, Math.trunc(v)));
}

function safeParseTags(jsonStr: string | null | undefined): string[] {
  if (!jsonStr) return [];
  try {
    const v = JSON.parse(jsonStr);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const STOP_WORDS = new Set([
  'a','an','and','are','about','at','be','by','do','for','from','have','how','i','in','is','it','me','my','of','on','or','that','the','these','this','to','what','where','which','with','you','your','notes','note','tell','say'
]);

function tokenize(s: string): string[] {
  const raw = s.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const filtered = raw.filter((term) => term.length > 2 && !STOP_WORDS.has(term));
  return filtered.length > 0 ? filtered : raw;
}

function rankNotes(notes: SourceNote[], queryParts: string[], topK: number): SourceNote[] {
  const query = queryParts.join(' ').trim().toLowerCase();
  const terms = tokenize(query);
  const uniqueTerms = Array.from(new Set(terms));
  if (!query || uniqueTerms.length === 0) return notes.slice(0, topK).map(withPromptChunk);

  const scored = notes.map((note) => scoreNote(note, query, uniqueTerms));
  scored.sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt);
  return scored.filter((x) => x.score > 0).slice(0, topK).map((x) => x.note);
}

function scoreNote(note: SourceNote, fullQuery: string, terms: string[]): { note: SourceNote; score: number } {
  const metaScore = scoreNoteMetadata(note, fullQuery, terms);
  const chunks = sourceChunks(note.sourceContentText || '');
  let bestChunk = chunks[0] || '';
  let bestChunkScore = 0;
  for (const chunk of chunks) {
    const score = scoreTextBlock(chunk, fullQuery, terms);
    if (score > bestChunkScore) {
      bestChunkScore = score;
      bestChunk = chunk;
    }
  }
  const score = metaScore + bestChunkScore;
  return { note: bestChunk ? { ...note, sourceContentText: focusChunk(bestChunk, fullQuery, terms) } : note, score };
}

function withPromptChunk(note: SourceNote): SourceNote {
  const chunk = sourceChunks(note.sourceContentText || '')[0];
  return chunk ? { ...note, sourceContentText: chunk } : note;
}

function scoreNoteMetadata(note: SourceNote, fullQuery: string, terms: string[]): number {
  const firstLine = noteDisplayTitle(note).toLowerCase();
  const tagSet = new Set(note.tags.map((t) => t.toLowerCase()));
  const metadata = [
    note.text,
    note.sourceTitle,
    note.sourceDescription,
    note.sourceSiteName,
    note.sourceUrl,
    note.tags.map((tag) => `#${tag}`).join(' '),
  ].filter(Boolean).join('\n');
  let score = scoreTextBlock(metadata, fullQuery, terms);

  if (firstLine === fullQuery) score += 30;
  for (const term of terms) {
    if (tagSet.has(term)) score += 10;
    if (firstLine === term) score += 12;
    else if (firstLine.includes(term)) score += 6;
  }
  return score;
}

function scoreTextBlock(text: string, fullQuery: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  if (haystack === fullQuery) score += 40;
  else if (haystack.includes(fullQuery)) score += 18;
  for (const term of terms) if (haystack.includes(term)) score += 3;
  if (terms.length > 0 && terms.every((term) => haystack.includes(term))) score += 8;
  return score;
}

function focusChunk(chunk: string, fullQuery: string, terms: string[]): string {
  const lower = chunk.toLowerCase();
  let hit = lower.indexOf(fullQuery);
  if (hit < 0) {
    hit = terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  }
  const sentence = Math.max(chunk.lastIndexOf('. ', hit), chunk.lastIndexOf('\n', hit));
  const start = sentence >= 0 && hit - sentence < 240 ? sentence + 1 : hit;
  const end = Math.min(chunk.length, start + CHAT_CHUNK_CHARS);
  return `${start > 0 ? '…' : ''}${chunk.slice(start, end).trim()}${end < chunk.length ? '…' : ''}`;
}

function sourceChunks(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= CHAT_CHUNK_CHARS) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length && chunks.length < CHAT_MAX_CHUNKS_PER_NOTE) {
    let end = Math.min(normalized.length, start + CHAT_CHUNK_CHARS);
    if (end < normalized.length) {
      const space = normalized.lastIndexOf(' ', end);
      if (space > start + CHAT_CHUNK_CHARS / 2) end = space;
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(end - CHAT_CHUNK_OVERLAP, start + 1);
  }
  return chunks.filter(Boolean);
}

async function answerFromNotes(
  env: Env,
  message: string,
  history: ChatMessage[],
  sources: SourceNote[],
  onDelta: (text: string) => void | Promise<void>,
): Promise<string> {
  const ai = await tryBedrockAnswer(env, message, history, sources, onDelta).catch((err) => {
    console.warn('[chat] bedrock answer failed; using fallback', err);
    return null;
  });
  if (ai) return ai;
  const fallback = fallbackAnswer(message, sources);
  await onDelta(fallback);
  return fallback;
}

async function tryBedrockAnswer(
  env: Env,
  message: string,
  history: ChatMessage[],
  sources: SourceNote[],
  onDelta: (text: string) => void | Promise<void>,
): Promise<string | null> {
  const region = env.AWS_REGION;
  const hasBearer = !!env.AWS_BEARER_TOKEN_BEDROCK;
  const hasSigV4 = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  if (!region || (!hasBearer && !hasSigV4)) return null;

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
  const sourceBlock = sources.map((note, i) => (
    `[#${i + 1}] uuid=${note.uuid}\ntags=${note.tags.join(', ')}\nsource=${note.sourceUrl || ''}\ntext=${noteSearchText(note).slice(0, 1800)}`
  )).join('\n\n');
  const historyBlock = history.map((m) => `${m.role}: ${m.content}`).join('\n');

  const stream = streamText({
    model: bedrock(modelId),
    system: NOTES_CHAT_SYSTEM_PROMPT,
    prompt: [
      historyBlock ? `Recent chat:\n${historyBlock}` : '',
      `Question:\n${message}`,
      `Saved links:\n${sourceBlock || '(no matching links)'}`,
    ].filter(Boolean).join('\n\n'),
    maxRetries: 1,
  });
  let answer = '';
  try {
    for await (const delta of stream.textStream) {
      answer += delta;
      await onDelta(delta);
    }
  } catch (err) {
    if (answer.trim()) return answer.trim();
    throw err;
  }
  return answer.trim() || null;
}

async function suggestQuestions(env: Env, notes: SourceNote[], history: ChatMessage[] = []): Promise<string[]> {
  const ai = await tryBedrockQuestions(env, notes, history).catch((err) => {
    console.warn('[chat] bedrock suggestions failed; using fallback', err);
    return null;
  });
  const fallback = fallbackSuggestedQuestions(notes, history);
  return normalizeQuestions(ai ?? fallback, fallback);
}

async function tryBedrockQuestions(env: Env, notes: SourceNote[], history: ChatMessage[]): Promise<string[] | null> {
  if (notes.length === 0) return null;
  const region = env.AWS_REGION;
  const hasBearer = !!env.AWS_BEARER_TOKEN_BEDROCK;
  const hasSigV4 = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  if (!region || (!hasBearer && !hasSigV4)) return null;

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
  const noteBlock = notes.map((note, i) => (
    `[#${i + 1}] tags=${note.tags.join(', ') || 'untagged'}\n${notePreviewText(note, 500)}`
  )).join('\n\n');
  const chatBlock = history.map((m) => `${m.role}: ${m.content}`).join('\n');
  const out = await generateText({
    model: bedrock(env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL),
    system: [
      'Generate 4 personal suggested chat inputs for the user.',
      'If recent chat is present, make them useful follow-up questions; otherwise make starter questions.',
      'Use specific topics, tags, or phrasing from the saved links; avoid generic "recent links" questions.',
      'Return only a JSON array of 4 short strings. Each string must be a question.',
    ].join('\n'),
    prompt: [chatBlock ? `Recent chat:\n${chatBlock}` : '', `Recent links:\n${noteBlock}`].filter(Boolean).join('\n\n'),
    maxRetries: 1,
  });
  return parseQuestionArray(out.text);
}

function parseQuestionArray(text: string): string[] | null {
  const raw = text.trim();
  const json = raw.startsWith('[') ? raw : raw.match(/\[[\s\S]*\]/)?.[0];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

function fallbackSuggestedQuestions(notes: SourceNote[], history: ChatMessage[] = []): string[] {
  const tags = topTags(notes);
  const topics = notes.map(questionTopic).filter(Boolean);
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content.replace(/\s+/g, ' ').trim();
  return [
    lastUser && `What should I ask next about "${lastUser.slice(0, 48)}"?`,
    lastUser && `Which saved links support or contradict that?`,
    tags[0] && `What have I been circling around in #${tags[0]}?`,
    topics[0] && `What does "${topics[0]}" connect to?`,
    tags[1] && `What should I do next from my #${tags[1]} links?`,
    topics[1] && `What am I missing about "${topics[1]}"?`,
    'What have I left unresolved lately?',
    'What should I write down first?',
  ].filter((q): q is string => Boolean(q));
}

function suggestionCacheKey(notes: SourceNote[], history: ChatMessage[]): string {
  const noteKey = notes.map((note) => `${note.uuid}:${note.updatedAt}`).join('|');
  const chatKey = history.map((m) => `${m.role}:${m.content}`).join('|');
  return `${noteKey}::${chatKey}`;
}

function topTags(notes: SourceNote[]): string[] {
  const counts = new Map<string, number>();
  for (const note of notes) for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

function questionTopic(note: SourceNote): string {
  const topic = noteDisplayTitle(note);
  return topic.length > 54 ? `${topic.slice(0, 51).trim()}…` : topic;
}

function normalizeQuestions(questions: string[], fallback: string[] = fallbackSuggestedQuestions([])): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of questions) {
    const text = q.replace(/^[-*\d.)\s]+/, '').trim().replace(/[.。]+$/, '?');
    const question = text.endsWith('?') ? text : `${text}?`;
    const key = question.toLowerCase();
    if (question.length < 12 || question.length > 140 || seen.has(key)) continue;
    seen.add(key);
    out.push(question);
    if (out.length === 4) break;
  }
  return out.length ? out : fallback.slice(0, 4);
}

function fallbackAnswer(message: string, sources: SourceNote[]): string {
  if (sources.length === 0) {
    return `I couldn't find matching links for: "${message}". What should I use as the starting point?`;
  }
  const intro = `I found ${sources.length} relevant link${sources.length === 1 ? '' : 's'} for "${message}":`;
  const bullets = sources.slice(0, 4).map((note, i) => `- [#${i + 1}] ${notePreviewText(note, 180)}`);
  return [intro, ...bullets, '', 'What part should we unpack first?'].join('\n');
}

// Tiny fetch wrappers. In dev without wrangler (D-025), /api/* returns 404,
// so getNotes() falls back to SAMPLE_NOTES and createNote() becomes a no-op
// (the optimistic insert still works locally; it just won't persist).
//
// As of 2026-06-02 tags are a first-class field on the wire — POST/PATCH
// payloads carry an explicit `tags: string[]` and the server no longer
// derives tags from inline #hashtags.

import type { AgentCodexAuthStatus, AgentCodexDevicePoll, AgentCodexDeviceStart, AgentEvent, AgentExecResult, AgentHistory, AgentSession, AgentThinkingLevel, AgentTurnStreamEvent, ChatMessage, ChatSourceNote, ChatStreamEvent, Note, NoteWire, PendingSuggestion, SimilarNote, SuggestedQuestionsResponse } from './types';
import { noteDisplayTitle, notePreviewText, noteSearchText } from './link-note';

export type WikiSourceRef = { uuid: string; updatedAt: number; excerpt: string };
export type WikiPage = { slug: string; title: string; kind: 'topic' | 'project' | 'person' | 'pattern' | 'synthesis'; contentMd: string; sourceRefs: WikiSourceRef[]; relatedSlugs: string[]; createdAt: number; updatedAt: number };
import { SAMPLE_NOTES } from './sample-data';

const CHAT_FALLBACK_LIMIT = 6;
const CHAT_STOP_WORDS = new Set([
  'a','an','and','are','about','at','be','by','do','for','from','have','how','i','in','is','it','me','my','of','on','or','that','the','these','this','to','what','where','which','with','you','your','notes','note','tell','say'
]);

let usingFallback = false;
export const isFallback = () => usingFallback;

const SUGGESTED_QUESTIONS_CACHE_KEY = 'board:agentSuggestedQuestions:v2';
const SUGGESTED_QUESTIONS_CACHE_MS = 20 * 24 * 60 * 60 * 1000;

type SuggestedQuestionOpts = { history?: ChatMessage[]; refresh?: boolean };
type SuggestedQuestionCache = { key: string; expiresAt: number; questions: string[] };
type PiTurnOpts = { workdir?: string; modelId?: string; thinkingLevel?: AgentThinkingLevel; debug?: boolean };

function deserialize(w: NoteWire): Note {
  let tags: string[] = [];
  try { tags = JSON.parse(w.tags); if (!Array.isArray(tags)) tags = []; } catch { tags = []; }
  const out: Note = { ...w, tags };
  if (w.pendingSuggestion) out.pendingSuggestion = w.pendingSuggestion;
  return out;
}

/** Fetch + JSON-decode, returning null on network throw or non-OK response.
 *  Used by wrappers that have no offline-fallback (accept/reject suggestion, rename/delete tag).
 *  Wrappers with offline-fallback (getNotes, createNote, updateNote, deleteNote) keep their
 *  own try/catch because they synthesize a local result instead of returning null. */
async function fetchOrNull<T>(url: string, init?: RequestInit): Promise<T | null> {
  const method = init?.method ?? 'GET';
  try {
    const r = await fetch(url, init);
    if (!r.ok) {
      console.error('[board]', method, url, 'failed:', r.status);
      return null;
    }
    return await r.json() as T;
  } catch (err) {
    console.error('[board]', method, url, 'threw:', err);
    return null;
  }
}

export async function getNotes(): Promise<Note[]> {
  try {
    const res = await fetch('/api/notes', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET /api/notes → ${res.status}`);
    const body = (await res.json()) as { notes: NoteWire[] };
    return body.notes.map(deserialize);
  } catch (err) {
    console.warn('[board] /api/notes unreachable, using sample data', err);
    usingFallback = true;
    return SAMPLE_NOTES.slice();
  }
}

export async function createNote(input: { text?: string; tags?: string[]; sourceUrl?: string }): Promise<Note | null> {
  const text = input.text ?? '';
  const tags = input.tags ?? [];
  const sourceUrl = input.sourceUrl?.trim() || undefined;
  if (usingFallback) {
    const now = Date.now();
    return {
      uuid: crypto.randomUUID().replace(/-/g, '').slice(0, 22),
      text: text || sourceUrl || '',
      tags: [...tags],
      color: null,
      createdAt: now,
      updatedAt: now,
      sourceUrl,
      sourceUrlNormalized: sourceUrl ?? null,
      sourceTitle: sourceUrl ?? null,
      sourceStatus: sourceUrl ? 'ready' : null,
    };
  }
  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, tags, sourceUrl }),
    });
    if (!res.ok) throw new Error(`POST /api/notes → ${res.status}`);
    const body = (await res.json()) as { note: NoteWire };
    return deserialize(body.note);
  } catch (err) {
    console.error('[board] createNote failed', err);
    return null;
  }
}

/** Update a note. At least one of `text` / `tags` must be defined.
 *  - `text` set        → bumps updated_at (board reshuffles).
 *  - `tags` set        → bumps tags_updated_at only (board stays put).
 *  - both              → both bump.
 *  Returns the full Note (server truth) including any still-pending suggestion. */
export async function updateNote(
  uuid: string,
  patch: { text?: string; tags?: string[] },
): Promise<Note | null> {
  if (usingFallback) {
    const now = Date.now();
    return {
      uuid,
      text: patch.text ?? '',
      tags: patch.tags ?? [],
      color: null,
      createdAt: now,
      updatedAt: now,
    };
  }
  try {
    const body: Record<string, unknown> = {};
    if (patch.text !== undefined) body.text = patch.text;
    if (patch.tags !== undefined) body.tags = patch.tags;
    const res = await fetch(`/api/notes/${encodeURIComponent(uuid)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH /api/notes/${uuid} → ${res.status}`);
    const r = (await res.json()) as { note: NoteWire };
    return deserialize(r.note);
  } catch (err) {
    console.error('[board] updateNote failed', err);
    return null;
  }
}

/** Delete a note permanently. */
export async function refreshLinkSource(uuid: string): Promise<Note | null> {
  if (usingFallback) return null;
  try {
    const res = await fetch(`/api/notes/${encodeURIComponent(uuid)}/refresh-link`, { method: 'POST' });
    if (!res.ok) throw new Error(`POST /api/notes/${uuid}/refresh-link → ${res.status}`);
    const body = (await res.json()) as { note: NoteWire };
    return deserialize(body.note);
  } catch (err) {
    console.error('[board] refreshLinkSource failed', err);
    return null;
  }
}

export async function deleteNote(uuid: string): Promise<boolean> {
  if (usingFallback) return true;
  try {
    const res = await fetch(`/api/notes/${encodeURIComponent(uuid)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`DELETE /api/notes/${uuid} → ${res.status}`);
    return true;
  } catch (err) {
    console.error('[board] deleteNote failed', err);
    return false;
  }
}

export async function acceptSuggestion(uuid: string, tags?: string[]): Promise<Note | null> {
  if (usingFallback) return null;
  const body = await fetchOrNull<{ note: NoteWire }>(
    `/api/notes/${encodeURIComponent(uuid)}/accept-suggestion`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tags ? { tags } : {}),
    },
  );
  return body ? deserialize(body.note) : null;
}

export async function rejectSuggestion(uuid: string, tags?: string[]): Promise<Note | null> {
  if (usingFallback) return null;
  const body = await fetchOrNull<{ note: NoteWire }>(
    `/api/notes/${encodeURIComponent(uuid)}/reject-suggestion`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tags ? { tags } : {}),
    },
  );
  return body ? deserialize(body.note) : null;
}


/** Batch position write — one round-trip per chunk, atomic per chunk on
 *  the server. Used by multi-drag, AI arrange, and seed-layout. The server
 *  caps each batch at 500, so we chunk client-side and treat the overall
 *  call as a success iff every chunk succeeds. */
const POSITION_BATCH_CHUNK = 400; // headroom under server's 500 cap
export async function batchUpdatePositions(
  updates: { uuid: string; x: number; y: number; z?: number }[],
): Promise<boolean> {
  if (updates.length === 0) return true;
  if (usingFallback) return true;
  for (let i = 0; i < updates.length; i += POSITION_BATCH_CHUNK) {
    const chunk = updates.slice(i, i + POSITION_BATCH_CHUNK);
    const res = await fetchOrNull<{ ok: true; updated: number }>(
      '/api/notes/positions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates: chunk }),
      },
    );
    if (res === null) return false;
  }
  return true;
}

/** SSE event surface from POST /api/ai/arrange/stream. Mirrors the server
 *  union in server/routes/ai.ts:AiArrangeEvent. The UI bar treats every
 *  non-`done` event as a transient slide-in toast. */
export type AiArrangeEvent =
  | { type: 'status'; message: string }
  | { type: 'tool-call'; name: string; argsPreview: string }
  | { type: 'tool-result'; name: string; resultPreview: string }
  | { type: 'done'; updates: { uuid: string; x: number; y: number }[]; explanation: string; strategy: string }
  | { type: 'error'; message: string };

/** Streaming variant of aiArrange. Calls `onEvent` for every server-sent
 *  progress event and resolves with the final `done` payload (or null on
 *  error / fallback unavailable). The server emits SSE; we parse it via
 *  the streaming fetch body — no EventSource because we need POST + JSON. */
export async function aiArrangeStream(
  prompt: string,
  onEvent: (ev: AiArrangeEvent) => void,
  contextHint?: { selectedUuids?: string[] },
): Promise<{ updates: { uuid: string; x: number; y: number }[]; explanation: string } | null> {
  if (usingFallback) return null;
  let res: Response;
  try {
    res = await fetch('/api/ai/arrange/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ prompt, context: contextHint ?? null }),
    });
  } catch (err) {
    console.warn('[ai] stream fetch failed', err);
    return null;
  }
  if (!res.ok || !res.body) {
    console.warn('[ai] stream not ok', res.status);
    return null;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done: { updates: { uuid: string; x: number; y: number }[]; explanation: string } | null = null;

  // SSE framing: each event ends in a blank line. Lines starting with `data:`
  // carry the JSON payload; we ignore comments, id:, retry:, etc.
  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = frame.split('\n').filter(l => l.startsWith('data:'));
      if (dataLines.length === 0) continue;
      const payload = dataLines.map(l => l.slice(5).replace(/^ /, '')).join('\n');
      let ev: AiArrangeEvent;
      try { ev = JSON.parse(payload) as AiArrangeEvent; }
      catch { continue; }
      try { onEvent(ev); } catch (err) { console.warn('[ai] onEvent threw', err); }
      if (ev.type === 'done') {
        done = { updates: ev.updates, explanation: ev.explanation };
      } else if (ev.type === 'error') {
        return null;
      }
    }
  }
  return done;
}


export async function createAgentSession(title?: string): Promise<{ session: AgentSession | null; error?: string; detail?: string; providerError?: string }> {
  try {
    const res = await fetch('/api/agent/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(title ? { title } : {}),
    });
    const body = await res.json().catch(() => ({})) as { session?: AgentSession; error?: string; detail?: string; providerError?: string };
    if (!res.ok) return { session: null, error: body.error || `POST /api/agent/sessions → ${res.status}`, detail: body.detail, providerError: body.providerError };
    return { session: body.session ?? null };
  } catch (err) {
    console.error('[board] createAgentSession failed', err);
    return { session: null, error: 'sandbox start failed', detail: String(err) };
  }
}

export async function listAgentSessions(): Promise<AgentSession[]> {
  const body = await fetchOrNull<{ sessions: AgentSession[] }>('/api/agent/sessions');
  return body?.sessions ?? [];
}

export async function getAgentCodexAuth(): Promise<AgentCodexAuthStatus | null> {
  return fetchOrNull<AgentCodexAuthStatus>('/api/agent/codex-auth');
}

export async function rotateAgentCodexAuth(json: string): Promise<AgentCodexAuthStatus | null> {
  return fetchOrNull<AgentCodexAuthStatus>('/api/agent/codex-auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json }),
  });
}

export async function startAgentCodexDeviceAuth(): Promise<AgentCodexDeviceStart | null> {
  return fetchOrNull<AgentCodexDeviceStart>('/api/agent/codex-auth/device', { method: 'POST' });
}

export async function pollAgentCodexDeviceAuth(id: string): Promise<AgentCodexDevicePoll | null> {
  return fetchOrNull<AgentCodexDevicePoll>(`/api/agent/codex-auth/device/${encodeURIComponent(id)}`, { method: 'POST' });
}

export async function getAgentSession(id: string): Promise<AgentSession | null> {
  const body = await fetchOrNull<{ session: AgentSession }>(`/api/agent/sessions/${encodeURIComponent(id)}`);
  return body?.session ?? null;
}

export async function getAgentHistory(id: string): Promise<AgentHistory | null> {
  return fetchOrNull<AgentHistory>(`/api/agent/sessions/${encodeURIComponent(id)}/history`);
}

export async function saveAgentMessageTurn(id: string, role: 'user' | 'assistant', content: string): Promise<boolean> {
  const body = await fetchOrNull<{ turn: unknown }>(`/api/agent/sessions/${encodeURIComponent(id)}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, kind: 'message', content }),
  });
  return !!body;
}

export async function stopAgentSession(id: string): Promise<AgentSession | null> {
  const body = await fetchOrNull<{ ok: true; session: AgentSession }>(`/api/agent/sessions/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  });
  return body?.session ?? null;
}

export async function deleteAgentSession(id: string): Promise<AgentSession | null> {
  const body = await fetchOrNull<{ ok: true; session: AgentSession }>(`/api/agent/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return body?.session ?? null;
}

export async function bootstrapAgentRuntime(id: string): Promise<{ result: AgentExecResult; event: AgentEvent } | null> {
  return fetchOrNull<{ result: AgentExecResult; event: AgentEvent }>(`/api/agent/sessions/${encodeURIComponent(id)}/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function streamPiTurn(
  id: string,
  message: string,
  onEvent: (ev: AgentTurnStreamEvent) => void,
  opts: PiTurnOpts = {},
): Promise<{ answer: string } | null> {
  return streamAgentEndpoint(`/api/agent/sessions/${encodeURIComponent(id)}/pi/stream`, { message, ...opts }, onEvent);
}

async function streamAgentEndpoint(
  url: string,
  body: Record<string, unknown>,
  onEvent: (ev: AgentTurnStreamEvent) => void,
): Promise<{ answer: string } | null> {
  return streamJsonEndpoint('agent', url, body, onEvent);
}

export async function findSimilarNotes(text: string, tags: string[] = [], limit = 8): Promise<SimilarNote[]> {
  if (usingFallback) {
    return rankChatSourceNotes(SAMPLE_NOTES, [text, ...tags], limit).map((note) => ({ ...note, reason: 'local match' }));
  }
  const body = await fetchOrNull<{ notes: SimilarNote[] }>('/api/agent/similar-notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, tags, limit }),
  });
  return body?.notes ?? [];
}

export async function saveChatNote(text: string, tags: string[] = []): Promise<Note | null> {
  if (usingFallback) return createNote({ text, tags });
  const body = await fetchOrNull<{ note: NoteWire }>('/api/chat/save-note', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, tags }),
  });
  return body ? deserialize(body.note) : null;
}

export async function saveWikiPage(input: {
  title: string;
  contentMd: string;
  sourceRefs?: WikiSourceRef[];
  relatedSlugs?: string[];
  kind?: WikiPage['kind'];
}): Promise<WikiPage | null> {
  const body = await fetchOrNull<{ page: WikiPage }>('/api/wiki/pages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'synthesis', ...input }),
  });
  return body?.page ?? null;
}

export async function getSuggestedQuestions(opts: SuggestedQuestionOpts = {}): Promise<string[]> {
  if (usingFallback) return fallbackSuggestedQuestions(SAMPLE_NOTES);
  const key = suggestedQuestionCacheKey(opts.history ?? []);
  const cached = !opts.refresh ? readSuggestedQuestionCache(key) : null;
  if (cached) return cached;
  const hasBody = opts.refresh || (opts.history?.length ?? 0) > 0;
  const body = await fetchOrNull<SuggestedQuestionsResponse>('/api/chat/suggestions', hasBody ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ history: (opts.history ?? []).slice(-6), refresh: opts.refresh === true }),
  } : undefined);
  const questions = body?.questions?.length ? body.questions.slice(0, 4) : fallbackSuggestedQuestions(SAMPLE_NOTES);
  writeSuggestedQuestionCache({ key, questions, expiresAt: Date.now() + SUGGESTED_QUESTIONS_CACHE_MS });
  return questions;
}

function suggestedQuestionCacheKey(history: ChatMessage[]): string {
  return history.slice(-6).map((m) => `${m.role}:${m.content}`).join('|') || 'initial';
}

function readSuggestedQuestionCache(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(SUGGESTED_QUESTIONS_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as SuggestedQuestionCache;
    return cached.key === key && cached.expiresAt > Date.now() ? cached.questions.slice(0, 4) : null;
  } catch {
    return null;
  }
}

function writeSuggestedQuestionCache(cache: SuggestedQuestionCache): void {
  try { localStorage.setItem(SUGGESTED_QUESTIONS_CACHE_KEY, JSON.stringify(cache)); } catch { /* noop */ }
}

export async function chatWithNotesStream(
  message: string,
  history: ChatMessage[],
  onEvent: (ev: ChatStreamEvent) => void,
): Promise<{ answer: string } | null> {
  if (usingFallback) {
    return runFallbackChat(message, history, onEvent);
  }
  return streamJsonEndpoint('chat', '/api/chat/stream', { message, history }, onEvent, (ev) => {
    if (ev.type === 'sources') {
      ev.notes = ev.notes.map((note) => ({ ...note, tags: Array.isArray(note.tags) ? note.tags : [] })) as ChatSourceNote[];
    }
    return ev;
  });
}

async function streamJsonEndpoint<T extends { type: string }>(
  label: string,
  url: string,
  body: unknown,
  onEvent: (ev: T) => void,
  normalize: (ev: T) => T = (ev) => ev,
): Promise<{ answer: string } | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`[${label}] stream fetch failed`, err);
    return null;
  }
  if (!res.ok || !res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer: string | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const payload = frame.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!payload) continue;
      let ev: T;
      try { ev = normalize(JSON.parse(payload) as T); }
      catch { continue; }
      onEvent(ev);
      const maybeAnswer = (ev as { type: string; answer?: unknown }).answer;
      if (ev.type === 'done' && typeof maybeAnswer === 'string') answer = maybeAnswer;
      if (ev.type === 'error') return null;
    }
  }
  return answer ? { answer } : null;
}

function runFallbackChat(
  message: string,
  history: ChatMessage[],
  onEvent: (ev: ChatStreamEvent) => void,
): { answer: string } {
  onEvent({ type: 'status', message: 'offline mode — searching sample notes…' });
  const sources = rankChatSourceNotes(SAMPLE_NOTES, [message, ...history.map((m) => m.content)], CHAT_FALLBACK_LIMIT);
  onEvent({ type: 'sources', notes: sources });
  const answer = buildFallbackAnswer(message, sources);
  onEvent({ type: 'done', answer });
  return { answer };
}

function rankChatSourceNotes(notes: ChatSourceNote[], queryParts: string[], topK: number): ChatSourceNote[] {
  const query = queryParts.join(' ').trim().toLowerCase();
  const terms = tokenizeChatQuery(query);
  if (!query || terms.length === 0) return notes.slice(0, topK);
  const scored = notes.map((note) => ({ note, score: scoreChatSource(note, query, terms) }));
  scored.sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt);
  return scored.filter((item) => item.score > 0).slice(0, topK).map((item) => item.note);
}

function tokenizeChatQuery(query: string): string[] {
  const raw = query.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const filtered = raw.filter((term) => term.length > 2 && !CHAT_STOP_WORDS.has(term));
  return filtered.length > 0 ? filtered : raw;
}

function scoreChatSource(note: ChatSourceNote, fullQuery: string, terms: string[]): number {
  const text = noteSearchText(note).toLowerCase();
  const firstLine = text.split('\n', 1)[0] ?? '';
  const tagSet = new Set(note.tags.map((tag) => tag.toLowerCase()));
  let score = 0;
  if (text === fullQuery) score += 40;
  else if (firstLine === fullQuery) score += 30;
  else if (text.includes(fullQuery)) score += 18;
  for (const term of terms) {
    if (tagSet.has(term)) score += 10;
    if (firstLine === term) score += 12;
    else if (firstLine.includes(term)) score += 6;
    if (text.includes(term)) score += 3;
  }
  if (terms.every((term) => text.includes(term))) score += 8;
  return score;
}

function fallbackSuggestedQuestions(notes: ChatSourceNote[]): string[] {
  const tags = topTags(notes);
  const topics = notes.map(questionTopic).filter(Boolean);
  return [
    tags[0] && `What have I been circling around in #${tags[0]}?`,
    topics[0] && `What does "${topics[0]}" connect to?`,
    tags[1] && `What should I do next from my #${tags[1]} notes?`,
    topics[1] && `What am I missing about "${topics[1]}"?`,
    'What have I left unresolved lately?',
    'What should I write down first?',
  ].filter((q): q is string => Boolean(q)).slice(0, 4);
}

function topTags(notes: ChatSourceNote[]): string[] {
  const counts = new Map<string, number>();
  for (const note of notes) for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

function questionTopic(note: ChatSourceNote): string {
  const topic = noteDisplayTitle(note).replace(/\s+/g, ' ').trim();
  return topic.length > 54 ? `${topic.slice(0, 51).trim()}…` : topic;
}

function buildFallbackAnswer(message: string, sources: ChatSourceNote[]): string {
  if (sources.length === 0) {
    return `I couldn't find matching notes for: "${message}".`;
  }
  const intro = usingFallback
    ? `Offline mode: I found ${sources.length} matching sample note${sources.length === 1 ? '' : 's'} for "${message}":`
    : `I found ${sources.length} relevant note${sources.length === 1 ? '' : 's'} for "${message}":`;
  const bullets = sources.slice(0, 4).map((note, i) => `- [#${i + 1}] ${notePreviewText(note, 180)}`);
  return [intro, ...bullets].join('\n');
}

export type { ChatMessage, ChatSourceNote, ChatStreamEvent, PendingSuggestion, SimilarNote };

#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createAgentSession, defineTool, SessionManager } from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai';

const prompt = process.argv.slice(2).join(' ').trim();
if (!prompt) throw new Error('prompt required');

const boardApiBase = requiredEnv('BOARD_API_BASE');
const boardSessionId = requiredEnv('BOARD_AGENT_SESSION_ID');
const boardToken = requiredEnv('BOARD_AGENT_TOKEN');
const boardOwner = process.env.BOARD_AGENT_OWNER || '';
const cwd = process.env.PI_WORKDIR || process.cwd();
const sessionDir = process.env.PI_SESSION_DIR || cwd;
const agentDir = process.env.PI_CODING_AGENT_DIR || `${sessionDir.replace(/\/sessions\/?$/, '')}/agent`;
writeOpenAICodexAuth(agentDir);
const providerId = process.env.LLM_PROVIDER || (process.env.OPENAI_CODEX_OAUTH_JSON ? 'openai-codex' : 'amazon-bedrock');
const modelId = process.env.LLM_MODEL || process.env.BEDROCK_MODEL_ID || (providerId === 'openai-codex' ? 'gpt-5.5' : 'us.anthropic.claude-opus-4-6-v1');
const thinkingLevel = normalizeThinkingLevel(process.env.PI_THINKING_LEVEL) || 'medium';
const readOnly = process.env.BOARD_READONLY === '1';
const model = getModel(providerId, modelId);
if (!model) throw new Error(`Model not found in pi-ai catalog: ${providerId}/${modelId}`);

const seen = new Set();
let answer = '';

const searchNotes = defineTool({
  name: 'search_notes',
  label: 'search notes',
  description: 'Search the user\'s Board notes. Returns createdAtIso, updatedAtIso, and ageDays so stale notes are obvious.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Literal grep query. Matches note text and tags; use #tag or tag:tag for exact tag search. Empty string returns most recently updated notes; use query "" with limit 1 for the latest note. Phrases like "latest note" also return recency.' },
      limit: { type: 'number', description: 'Max notes to return, 1-100.' },
      createdAfter: { type: 'string', description: 'Optional ISO date/date-time; only notes created on or after it.' },
      createdBefore: { type: 'string', description: 'Optional ISO date/date-time; only notes created on or before it.' },
      updatedAfter: { type: 'string', description: 'Optional ISO date/date-time; only notes updated on or after it.' },
      updatedBefore: { type: 'string', description: 'Optional ISO date/date-time; only notes updated on or before it.' },
      context: { type: 'number', description: 'Grep context lines around each match, 0-3.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(_toolCallId, params) {
    const json = await boardFetch(`/api/agent/sessions/${encodeURIComponent(boardSessionId)}/notes/search`, noteSearchBody(params, 'query'));
    return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
  },
});

const grepNotes = defineTool({
  name: 'grep_notes',
  label: 'grep notes',
  description: 'Expensive full-text grep over all Board notes. Returns matching lines/snippets, note payloads, and freshness metadata.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Literal grep pattern. Matches note text and tags; #tag or tag:tag searches exact tags. Empty string returns recent notes.' },
      limit: { type: 'number', description: 'Max notes to return, 1-100.' },
      createdAfter: { type: 'string', description: 'Optional ISO date/date-time; only notes created on or after it.' },
      createdBefore: { type: 'string', description: 'Optional ISO date/date-time; only notes created on or before it.' },
      updatedAfter: { type: 'string', description: 'Optional ISO date/date-time; only notes updated on or after it.' },
      updatedBefore: { type: 'string', description: 'Optional ISO date/date-time; only notes updated on or before it.' },
      context: { type: 'number', description: 'Grep context lines around each match, 0-3.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(_toolCallId, params) {
    const json = await boardFetch(`/api/agent/sessions/${encodeURIComponent(boardSessionId)}/notes/search`, noteSearchBody(params, 'pattern'));
    return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
  },
});

const saveNote = defineTool({
  name: 'save_note',
  label: 'save note',
  description: 'Save a new note to Board. Use when the user asks to remember, save, or add a note.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Note body to save.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags without #.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  async execute(_toolCallId, params) {
    const text = typeof params?.text === 'string' ? params.text.trim() : '';
    if (!text) return { content: [{ type: 'text', text: 'Error: text required' }] };
    const tags = Array.isArray(params?.tags) ? params.tags.filter((tag) => typeof tag === 'string') : [];
    const json = await boardFetch(`/api/agent/sessions/${encodeURIComponent(boardSessionId)}/notes`, { text, tags });
    return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
  },
});

const searchWiki = defineTool({
  name: 'search_wiki',
  label: 'search wiki',
  description: 'Search compiled Board Wiki pages before searching raw notes.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query for wiki title, kind, slug, or markdown content.' },
      limit: { type: 'number', description: 'Max pages to return, 1-50.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(_toolCallId, params) {
    const query = typeof params?.query === 'string' ? params.query : '';
    const limit = typeof params?.limit === 'number' ? Math.max(1, Math.min(50, Math.trunc(params.limit))) : 20;
    const json = await boardGet(`/api/wiki/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
  },
});

const readWikiPage = defineTool({
  name: 'read_wiki_page',
  label: 'read wiki page',
  description: 'Read one compiled Board Wiki page by slug.',
  parameters: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'Wiki page slug.' },
    },
    required: ['slug'],
    additionalProperties: false,
  },
  async execute(_toolCallId, params) {
    const slug = typeof params?.slug === 'string' ? params.slug.trim() : '';
    if (!slug) return { content: [{ type: 'text', text: 'Error: slug required' }] };
    const json = await boardGet(`/api/wiki/pages/${encodeURIComponent(slug)}`);
    return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
  },
});

const upsertWikiPage = defineTool({
  name: 'upsert_wiki_page',
  label: 'upsert wiki page',
  description: 'Create or update a compiled Board Wiki page. Use only when the user explicitly asks to save or update wiki memory.',
  parameters: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'Optional slug; derived from title when omitted.' },
      title: { type: 'string', description: 'Page title.' },
      kind: { type: 'string', description: 'One of topic, project, person, pattern, synthesis.' },
      contentMd: { type: 'string', description: 'Markdown page content.' },
      sourceRefs: { type: 'array', items: { type: 'object' }, description: 'Evidence refs: {uuid, updatedAt, excerpt}.' },
      relatedSlugs: { type: 'array', items: { type: 'string' }, description: 'Related wiki page slugs.' },
      summary: { type: 'string', description: 'Short event summary.' },
    },
    required: ['title', 'kind', 'contentMd'],
    additionalProperties: false,
  },
  async execute(_toolCallId, params) {
    const json = await boardFetch('/api/wiki/pages', params || {});
    return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
  },
});

const restoredSessionFile = await restoreSessionFromBoard();
const { session } = await createAgentSession({
  cwd,
  model,
  thinkingLevel,
  agentDir,
  sessionManager: SessionManager.open(restoredSessionFile, sessionDir, cwd),
  tools: readOnly
    ? ['search_wiki', 'read_wiki_page', 'search_notes', 'grep_notes']
    : ['read', 'bash', 'grep', 'find', 'edit', 'write', 'search_wiki', 'read_wiki_page', 'upsert_wiki_page', 'search_notes', 'grep_notes', 'save_note'],
  customTools: readOnly
    ? [searchWiki, readWikiPage, searchNotes, grepNotes]
    : [searchWiki, readWikiPage, upsertWikiPage, searchNotes, grepNotes, saveNote],
});

try {
  session.subscribe((event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      answer += event.assistantMessageEvent.delta;
    }
  });

  await session.prompt([
    'You are running inside a Cloudflare Sandbox container for the Board notes app.',
    readOnly ? 'Read-only mode: use search_wiki/read_wiki_page/search_notes/grep_notes only; do not save notes, write wiki pages, edit files, or run shell commands.' : 'Use search_wiki/read_wiki_page before raw notes. Use upsert_wiki_page only when the user explicitly asks to save or update wiki memory. Use grep_notes/search_notes/save_note for Board notes; do not write curl commands for those APIs.',
    'For recurring topics, search compiled wiki pages first; then use grep_notes/search_notes for fresh raw evidence.',
    'For note recall, prefer grep_notes: it scans all notes and returns grep-like matching lines/snippets.',
    'Note search results include createdAtIso, updatedAtIso, and ageDays. Prefer newer notes when relevance is similar; mention when context seems stale.',
    'If the user asks about the latest or most recent note, call search_notes first; use query "" with limit 1 for one note, or a small limit for recent notes.',
    '',
    'User request:',
    prompt,
  ].join('\n'));
  await mirrorPiSessionFile();
} finally {
  session.dispose();
}

async function restoreSessionFromBoard() {
  mkdirSync(sessionDir, { recursive: true });
  const file = `${sessionDir.replace(/\/$/, '')}/${safeFileName(boardSessionId)}.jsonl`;
  if (existsSync(file) && readFileSync(file, 'utf8').trim()) return file;
  let history = null;
  try {
    history = await boardGet(`/api/agent/sessions/${encodeURIComponent(boardSessionId)}/history`);
  } catch (err) {
    // ponytail: if D1 history fetch fails, run as a fresh pi session; Board tools will surface the same outage.
    console.error(`[board] history restore failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { entries, fromPiEntries } = buildResumeEntries(history);
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  if (fromPiEntries) for (const entry of entries) if (typeof entry.id === 'string') seen.add(entry.id);
  return file;
}

async function boardGet(path) {
  return boardJson(await fetch(`${boardApiBase.replace(/\/$/, '')}${path}`, { headers: boardHeaders(), redirect: 'manual' }));
}

async function boardFetch(path, body) {
  return boardJson(await fetch(`${boardApiBase.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: boardHeaders('json'),
    body: JSON.stringify(body),
    redirect: 'manual',
  }));
}

async function boardJson(res) {
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new Error(`${res.status} empty response`);
    return null;
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    const location = res.headers.get('location');
    const target = location ? ` redirect to ${location}` : '';
    throw new Error(`Board API returned non-JSON ${res.status} ${type || 'unknown content-type'}${target}: ${text.slice(0, 180)}`);
  }
  const json = JSON.parse(text);
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return json;
}

async function mirrorPiSessionFile() {
  if (!session.sessionFile || !existsSync(session.sessionFile)) return;
  const entries = readFileSync(session.sessionFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => typeof entry.id === 'string' && !seen.has(entry.id));
  for (const entry of entries) if (typeof entry.id === 'string') seen.add(entry.id);
  if (entries.length === 0) return;

  for (let i = 0; i < entries.length; i += 200) {
    await fetch(`${boardApiBase.replace(/\/$/, '')}/api/agent/sessions/${encodeURIComponent(boardSessionId)}/pi-entries`, {
      method: 'POST',
      headers: boardHeaders('json'),
      body: JSON.stringify({ entries: entries.slice(i, i + 200), session: { id: session.sessionId, file: session.sessionFile, cwd } }),
    });
  }
}

function buildResumeEntries(history) {
  const piEntries = (history?.piEntries ?? [])
    .map((entry) => entry.raw)
    .filter((raw) => isRecord(raw) && typeof raw.id === 'string' && typeof raw.type === 'string');
  if (piEntries.length > 0) {
    const header = piEntries.find((entry) => entry.type === 'session') ?? sessionHeader(history);
    return { entries: [header, ...piEntries.filter((entry) => entry.type !== 'session')], fromPiEntries: true };
  }

  const turns = (history?.turns ?? []).filter((turn) => turn.kind === 'message' && (turn.role === 'user' || turn.role === 'assistant'));
  const tail = turns[turns.length - 1];
  if (tail?.role === 'user' && tail.content.trim() === prompt) turns.pop();
  const entries = [sessionHeader(history)];
  let parentId = null;
  for (const turn of turns) {
    const id = `d1${hash(`${turn.id}:${turn.role}:${turn.createdAt}`).slice(0, 10)}`;
    entries.push({ type: 'message', id, parentId, timestamp: iso(turn.createdAt), message: turnMessage(turn) });
    parentId = id;
  }
  return { entries, fromPiEntries: false };
}

function sessionHeader(history) {
  return { type: 'session', version: 3, id: boardSessionId, timestamp: iso(history?.session?.createdAt), cwd };
}

function turnMessage(turn) {
  if (turn.role === 'user') return { role: 'user', content: turn.content, timestamp: turn.createdAt };
  return {
    role: 'assistant',
    content: [{ type: 'text', text: turn.content }],
    api: 'board-d1',
    provider: 'board-d1',
    model: 'd1-resume',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: turn.createdAt,
  };
}

function boardHeaders(kind) {
  const headers = { accept: 'application/json', authorization: `Bearer ${boardToken}`, 'x-board-agent-owner': boardOwner };
  if (kind === 'json') headers['content-type'] = 'application/json';
  return headers;
}

function noteSearchBody(params, queryKey) {
  const p = isRecord(params) ? params : {};
  const body = {
    query: typeof p[queryKey] === 'string' ? p[queryKey] : '',
    limit: typeof p.limit === 'number' ? p.limit : 20,
  };
  for (const key of ['createdAfter', 'createdBefore', 'updatedAfter', 'updatedBefore']) {
    if (typeof p[key] === 'string') body[key] = p[key];
  }
  if (typeof p.context === 'number') body.context = p.context;
  return body;
}

function iso(ms) {
  return new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || 'session';
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

function writeOpenAICodexAuth(agentDir) {
  const raw = process.env.OPENAI_CODEX_OAUTH_JSON;
  if (!raw) return;
  // ponytail: Worker secret is source of truth; add D1 token sync if refresh rotation bites.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OPENAI_CODEX_OAUTH_JSON must be valid JSON');
  }
  const source = isRecord(parsed) && isRecord(parsed['openai-codex']) ? parsed['openai-codex'] : parsed;
  if (!isRecord(source)) throw new Error('OPENAI_CODEX_OAUTH_JSON must be an oauth object or auth.json object');
  const access = typeof source.access === 'string' ? source.access : '';
  const refresh = typeof source.refresh === 'string' ? source.refresh : '';
  const expires = typeof source.expires === 'number' ? source.expires : Number(source.expires);
  if (!access || !refresh || !Number.isFinite(expires)) throw new Error('OPENAI_CODEX_OAUTH_JSON requires access, refresh, and expires');
  const auth = { type: 'oauth', access, refresh, expires };
  if (typeof source.accountId === 'string') auth.accountId = source.accountId;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(`${agentDir.replace(/\/$/, '')}/auth.json`, `${JSON.stringify({ 'openai-codex': auth }, null, 2)}\n`, { mode: 0o600 });
}

function normalizeThinkingLevel(value) {
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value || '') ? value : undefined;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
}

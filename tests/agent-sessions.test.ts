import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../server/index';
import { CloudflareSandboxClient } from '../server/lib/cloudflare-sandbox';
import { freshShimDb } from './helpers/d1-shim';

type Env = {
  DB: D1Database;
  Sandbox?: unknown;
  AGENT_CALLBACK_BASE_URL?: string;
  AGENT_LLM_PROVIDER?: string;
  AGENT_LLM_MODEL_ID?: string;
  OPENAI_CODEX_OAUTH_JSON?: string;
};

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATIONS = [
  path.join(MIGRATIONS_DIR, '0001_initial.sql'),
  path.join(MIGRATIONS_DIR, '0002_tag_suggestions.sql'),
  path.join(MIGRATIONS_DIR, '0003_tags_standalone.sql'),
  path.join(MIGRATIONS_DIR, '0004_ai_arrange_log.sql'),
  path.join(MIGRATIONS_DIR, '0005_agent_sessions.sql'),
  path.join(MIGRATIONS_DIR, '0006_agent_history.sql'),
  path.join(MIGRATIONS_DIR, '0007_agent_pi_entries.sql'),
  path.join(MIGRATIONS_DIR, '0008_agent_secrets.sql'),
  path.join(MIGRATIONS_DIR, '0011_links_metadata.sql'),
  path.join(MIGRATIONS_DIR, '0012_source_chunks.sql'),
];

async function call(env: Env, method: string, reqPath: string, body?: unknown, origin = 'http://test.local'): Promise<Response> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.fetch(new Request(`${origin}${reqPath}`, init), env);
}

async function setNoteDate(text: string, iso: string): Promise<void> {
  const ms = Date.parse(iso);
  await env.DB.prepare('UPDATE notes SET created_at = ?, updated_at = ? WHERE text = ?').bind(ms, ms, text).run();
}

function mockLiveSandbox(providerSessionId = 'live-board-session'): void {
  env.Sandbox = {};
  vi.spyOn(CloudflareSandboxClient.prototype, 'createSession').mockResolvedValue({
    providerSessionId,
    status: 'ready',
    previewUrl: null,
    cwd: '/workspace',
    errorMessage: null,
  });
  vi.spyOn(CloudflareSandboxClient.prototype, 'getSession').mockResolvedValue({
    providerSessionId,
    status: 'ready',
    previewUrl: null,
    cwd: '/workspace',
    errorMessage: null,
  });
  vi.spyOn(CloudflareSandboxClient.prototype, 'deleteSession').mockResolvedValue(undefined);
  vi.spyOn(CloudflareSandboxClient.prototype, 'runCommand').mockImplementation(async (_id, command) => ({ command, stdout: 'ok', parsed: { ok: true } }));
  vi.spyOn(CloudflareSandboxClient.prototype, 'streamCommand').mockImplementation(async (_id, command, onEvent) => {
    await onEvent({ stream: 'stdout', text: 'ok' });
    return { command, stdout: 'ok', parsed: { ok: true } };
  });
}

let env: Env;

beforeEach(() => {
  env = { DB: freshShimDb(MIGRATIONS) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent session routes', () => {
  it('creates a history-only session when Cloudflare Sandbox is not configured', async () => {
    const res = await call(env, 'POST', '/api/agent/sessions', { title: 'fallback question' });
    expect(res.status).toBe(201);
    const body = await res.json() as { session: { id: string; title: string | null; status: string; providerSessionId: string | null; errorMessage: string | null } };
    expect(body.session.title).toBe('fallback question');
    expect(body.session.status).toBe('stopped');
    expect(body.session.providerSessionId).toBeNull();
    expect(body.session.errorMessage).toContain('saving notes chat history');

    const userTurn = await call(env, 'POST', `/api/agent/sessions/${body.session.id}/turns`, { role: 'user', kind: 'message', content: 'hello fallback' });
    expect(userTurn.status).toBe(201);
    const assistantTurn = await call(env, 'POST', `/api/agent/sessions/${body.session.id}/turns`, { role: 'assistant', kind: 'message', content: 'hello saved' });
    expect(assistantTurn.status).toBe(201);

    const history = await call(env, 'GET', `/api/agent/sessions/${body.session.id}/history`);
    const historyBody = await history.json() as { turns: Array<{ role: string; content: string }> };
    expect(historyBody.turns.map((turn) => `${turn.role}:${turn.content}`)).toEqual(['user:hello fallback', 'assistant:hello saved']);
  });

  it('hides legacy stub placeholders from the history list', async () => {
    await env.DB.prepare("INSERT INTO agent_sessions (id, provider, provider_session_id, title, status, owner_email, created_at, updated_at) VALUES ('legacy-stub', 'cloudflare-sandbox', 'stub-old', 'legacy', 'stub', 'local-dev', 1, 1)").run();

    const listed = await call(env, 'GET', '/api/agent/sessions');
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { sessions: Array<{ id: string; status: string }> };
    expect(listBody.sessions.map((session) => session.id)).not.toContain('legacy-stub');
    expect(listBody.sessions.every((session) => session.status !== 'stub')).toBe(true);
  });

  it('uses the first user message as the history title for generic sandbox rows', async () => {
    mockLiveSandbox();

    const empty = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const emptyId = ((await empty.json()) as { session: { id: string } }).session.id;
    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const id = ((await created.json()) as { session: { id: string } }).session.id;

    await call(env, 'POST', `/api/agent/sessions/${id}/turns`, {
      role: 'user',
      kind: 'message',
      content: 'waht is a cool thing to work on?',
    });

    const listed = await call(env, 'GET', '/api/agent/sessions');
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { sessions: Array<{ id: string; title: string | null }> };
    expect(listBody.sessions.find((session) => session.id === id)?.title).toBe('waht is a cool thing to work on?');
    expect(listBody.sessions.map((session) => session.id)).not.toContain(emptyId);
  });

  it('returns the sandbox error when local Cloudflare Sandbox creation fails', async () => {
    vi.spyOn(CloudflareSandboxClient.prototype, 'createSession').mockRejectedValue(new Error('wrangler dev --remote is no longer supported for Durable Objects'));
    env.Sandbox = {};

    const res = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; detail: string; session?: unknown };
    expect(body.error).toBe('sandbox start failed');
    expect(body.detail).toContain('wrangler dev --remote is no longer supported');
    expect(body.session).toBeUndefined();
  });

  it('loads history from D1 without syncing the sandbox session', async () => {
    mockLiveSandbox();

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    expect(created.status).toBe(201);
    const createBody = await created.json() as { session: { id: string } };
    const id = createBody.session.id;

    const turn = await call(env, 'POST', `/api/agent/sessions/${id}/turns`, {
      role: 'user',
      kind: 'message',
      content: 'read this from d1',
    });
    expect(turn.status).toBe(201);
    vi.spyOn(CloudflareSandboxClient.prototype, 'getSession').mockRejectedValue(new Error('sandbox sync failed'));

    const synced = await call(env, 'GET', `/api/agent/sessions/${id}`);
    expect(synced.status).toBe(500);

    const history = await call(env, 'GET', `/api/agent/sessions/${id}/history`);
    expect(history.status).toBe(200);
    const historyBody = await history.json() as { session: { id: string }; turns: Array<{ content: string }> };
    expect(historyBody.session.id).toBe(id);
    expect(historyBody.turns[0].content).toBe('read this from d1');
  });

  it('appends turns, events, and artifacts to session history', async () => {
    mockLiveSandbox();

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const createBody = await created.json() as { session: { id: string } };
    const id = createBody.session.id;

    const turn = await call(env, 'POST', `/api/agent/sessions/${id}/turns`, {
      role: 'user',
      kind: 'message',
      content: 'summarize my AR notes',
    });
    expect(turn.status).toBe(201);
    const turnBody = await turn.json() as { turn: { id: number; seq: number } };
    expect(turnBody.turn.seq).toBe(1);

    const event = await call(env, 'POST', `/api/agent/sessions/${id}/events`, {
      turnId: turnBody.turn.id,
      type: 'tool_call',
      name: 'search_notes',
      payload: { query: 'AR' },
    });
    expect(event.status).toBe(201);

    const artifact = await call(env, 'POST', `/api/agent/sessions/${id}/artifacts`, {
      turnId: turnBody.turn.id,
      kind: 'note-draft',
      title: 'AR summary',
      contentText: 'Augmented reality is marked to learn.',
      metadata: { sourceCount: 1 },
    });
    expect(artifact.status).toBe(201);

    const history = await call(env, 'GET', `/api/agent/sessions/${id}/history`);
    expect(history.status).toBe(200);
    const historyBody = await history.json() as {
      turns: Array<{ content: string }>;
      events: Array<{ type: string; name: string | null; payload: { query?: string } }>;
      artifacts: Array<{ kind: string; title: string | null; metadata: { sourceCount?: number } }>;
    };
    expect(historyBody.turns[0].content).toContain('AR notes');
    expect(historyBody.events[0].type).toBe('tool_call');
    expect(historyBody.events[0].name).toBe('search_notes');
    expect(historyBody.events[0].payload.query).toBe('AR');
    expect(historyBody.artifacts[0].kind).toBe('note-draft');
    expect(historyBody.artifacts[0].metadata.sourceCount).toBe(1);
  });

  it('truncates oversized event payloads before saving them', async () => {
    mockLiveSandbox();

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const id = ((await created.json()) as { session: { id: string } }).session.id;
    const huge = 'x'.repeat(40_000);

    const event = await call(env, 'POST', `/api/agent/sessions/${id}/events`, {
      type: 'error',
      name: 'pi_stream',
      payload: { message: huge, debug: { stdout: huge, nested: { stderr: huge } } },
    });
    expect(event.status).toBe(201);

    const history = await call(env, 'GET', `/api/agent/sessions/${id}/history`);
    const body = await history.json() as { events: Array<{ payload: { message?: string; debug?: { stdout?: string; nested?: { stderr?: string } } } }> };
    expect(body.events[0].payload.message?.length).toBeLessThan(20_100);
    expect(body.events[0].payload.debug?.stdout?.length).toBeLessThan(20_100);
    expect(body.events[0].payload.debug?.nested?.stderr?.length).toBeLessThan(20_100);
  });

  it('rotates Codex OAuth JSON through the agent UI API without leaking it', async () => {
    env.OPENAI_CODEX_OAUTH_JSON = JSON.stringify({ type: 'oauth', access: 'env-access', refresh: 'env-refresh', expires: 4102444800000, accountId: 'acct_env' });

    const initial = await call(env, 'GET', '/api/agent/codex-auth');
    expect(initial.status).toBe(200);
    const initialBody = await initial.json() as { configured: boolean; source: string; valid: boolean; expiresAt: number | null };
    expect(initialBody).toMatchObject({ configured: true, source: 'worker-secret', valid: true, expiresAt: 4102444800000 });

    const rotated = await call(env, 'POST', '/api/agent/codex-auth', {
      json: JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'ui-access-secret', refresh: 'ui-refresh-secret', expires: 4102444900000, accountId: 'acct_ui' } }),
    });
    expect(rotated.status).toBe(200);
    const text = await rotated.text();
    expect(text).toContain('"source":"ui"');
    expect(text).toContain('4102444900000');
    expect(text).not.toContain('ui-access-secret');
    expect(text).not.toContain('ui-refresh-secret');
  });

  it('completes Codex device auth without leaking OAuth tokens', async () => {
    let tokenPolls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        return Response.json({ device_auth_id: 'device-secret', user_code: 'ABCD-EFGH', interval: 1 });
      }
      if (url.endsWith('/api/accounts/deviceauth/token')) {
        expect(String(init?.body)).toContain('device-secret');
        tokenPolls += 1;
        if (tokenPolls === 1) return new Response(JSON.stringify({ error: { code: 'deviceauth_authorization_pending' } }), { status: 403 });
        return Response.json({ authorization_code: 'auth-code-secret', code_verifier: 'verifier-secret' });
      }
      if (url.endsWith('/oauth/token')) {
        expect(String(init?.body)).toContain('auth-code-secret');
        return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const started = await call(env, 'POST', '/api/agent/codex-auth/device');
    expect(started.status).toBe(200);
    const startText = await started.text();
    expect(startText).toContain('ABCD-EFGH');
    expect(startText).not.toContain('device-secret');
    const startBody = JSON.parse(startText) as { id: string };

    const pending = await call(env, 'POST', `/api/agent/codex-auth/device/${startBody.id}`);
    expect(await pending.json()).toMatchObject({ status: 'pending' });

    const completed = await call(env, 'POST', `/api/agent/codex-auth/device/${startBody.id}`);
    expect(completed.status).toBe(200);
    const completedText = await completed.text();
    expect(completedText).toContain('"status":"complete"');
    expect(completedText).toContain('"source":"ui"');
    expect(completedText).not.toContain('auth-code-secret');
    expect(completedText).not.toContain('verifier-secret');
    expect(completedText).not.toContain('access-secret');
    expect(completedText).not.toContain('refresh-secret');
  });

  it('imports pi JSONL entries for cross-reference', async () => {
    mockLiveSandbox();

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const createBody = await created.json() as { session: { id: string } };
    const id = createBody.session.id;

    const imported = await call(env, 'POST', `/api/agent/sessions/${id}/pi-entries`, {
      entries: [
        { type: 'message', id: 'a1b2c3d4', parentId: null, timestamp: '2026-06-14T00:00:00.000Z', message: { role: 'user', content: 'hello pi' } },
        { type: 'message', id: 'b2c3d4e5', parentId: 'a1b2c3d4', timestamp: '2026-06-14T00:00:01.000Z', message: { role: 'toolResult', toolCallId: 'call_123', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false } },
      ],
    });
    expect(imported.status).toBe(200);
    const importBody = await imported.json() as { imported: number; projected: { turns: number; events: number } };
    expect(importBody.imported).toBe(2);
    expect(importBody.projected.turns).toBe(1);
    expect(importBody.projected.events).toBe(1);

    const history = await call(env, 'GET', `/api/agent/sessions/${id}/history`);
    const historyBody = await history.json() as { turns: unknown[]; events: unknown[]; piEntries: Array<{ piEntryId: string; piParentId: string | null; role: string | null; toolCallId: string | null; raw: { type?: string } }> };
    expect(historyBody.piEntries).toHaveLength(2);
    expect(historyBody.turns.length).toBeGreaterThanOrEqual(1);
    expect(historyBody.events.length).toBeGreaterThanOrEqual(1);
    expect(historyBody.piEntries[0].piEntryId).toBe('a1b2c3d4');
    expect(historyBody.piEntries[0].role).toBe('user');
    expect(historyBody.piEntries[1].piParentId).toBe('a1b2c3d4');
    expect(historyBody.piEntries[1].toolCallId).toBe('call_123');
    expect(historyBody.piEntries[1].raw.type).toBe('message');
  });

  it('backfills prewritten turns and stores mirrored pi session metadata', async () => {
    mockLiveSandbox();

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const createBody = await created.json() as { session: { id: string } };
    const id = createBody.session.id;

    const prewritten = await call(env, 'POST', `/api/agent/sessions/${id}/turns`, {
      role: 'user',
      kind: 'message',
      content: 'resume this from d1',
    });
    expect(prewritten.status).toBe(201);

    const imported = await call(env, 'POST', `/api/agent/sessions/${id}/pi-entries`, {
      session: { id: 'pi-session-1', file: '/workspace/board-sandbox-runtime/sessions/demo.jsonl', cwd: '/workspace' },
      entries: [
        { type: 'session', id: 'pi-session-1', timestamp: '2026-06-14T00:00:00.000Z', cwd: '/workspace' },
        { type: 'message', id: 'usr00001', parentId: null, timestamp: '2026-06-14T00:00:01.000Z', message: { role: 'user', content: 'resume this from d1' } },
        { type: 'message', id: 'ast00001', parentId: 'usr00001', timestamp: '2026-06-14T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'resumed answer' }] } },
      ],
    });
    expect(imported.status).toBe(200);

    const history = await call(env, 'GET', `/api/agent/sessions/${id}/history`);
    const historyBody = await history.json() as { session: { piSessionId: string | null; piSessionFile: string | null; piCwd: string | null; piLeafEntryId: string | null }; turns: Array<{ role: string; content: string; piEntryId: string | null }> };
    expect(historyBody.session.piSessionId).toBe('pi-session-1');
    expect(historyBody.session.piSessionFile).toContain('demo.jsonl');
    expect(historyBody.session.piCwd).toBe('/workspace');
    expect(historyBody.session.piLeafEntryId).toBe('ast00001');
    expect(historyBody.turns.filter((turn) => turn.role === 'user' && turn.content === 'resume this from d1')).toHaveLength(1);
    expect(historyBody.turns.filter((turn) => turn.role === 'assistant' && turn.content === 'resumed answer')).toHaveLength(1);
    expect(historyBody.turns.find((turn) => turn.role === 'user')?.piEntryId).toBe('usr00001');
  });

  it('bootstraps the pi runtime and streams a pi prompt through a live sandbox', async () => {
    mockLiveSandbox();

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const createBody = await created.json() as { session: { id: string } };
    const id = createBody.session.id;

    const bootstrap = await call(env, 'POST', `/api/agent/sessions/${id}/bootstrap`, {});
    expect(bootstrap.status).toBe(200);
    const bootstrapBody = await bootstrap.json() as { event: { type: string; name: string | null } };
    expect(bootstrapBody.event.type).toBe('bootstrap');
    expect(bootstrapBody.event.name).toBe('pi-runtime');

    const stream = await call(env, 'POST', `/api/agent/sessions/${id}/pi/stream`, { message: 'hello from pi' });
    expect(stream.status).toBe(200);
    const text = await stream.text();
    expect(text).not.toContain('"type":"pi_entries"');
    expect(text).toContain('"type":"done"');

    const history = await call(env, 'GET', `/api/agent/sessions/${id}/history`);
    const historyBody = await history.json() as { turns: Array<{ role: string; content: string }>; events: Array<{ type: string }> };
    expect(historyBody.turns.length).toBeGreaterThanOrEqual(2);
    expect(historyBody.turns.filter((turn) => turn.role === 'user' && turn.content === 'hello from pi')).toHaveLength(1);
    expect(historyBody.events.some((event) => event.type === 'bootstrap')).toBe(true);
  });

  it('streams only visible text deltas from pi updates', async () => {
    mockLiveSandbox();
    vi.spyOn(CloudflareSandboxClient.prototype, 'streamCommand').mockImplementation(async (_id, command, onEvent) => {
      await onEvent({ stream: 'stdout', text: `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'private scratchpad' } })}\n` });
      await onEvent({ stream: 'stdout', text: `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'public answer' } })}\n` });
      return { command, stdout: '', parsed: { ok: true } };
    });

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const createBody = await created.json() as { session: { id: string } };
    const stream = await call(env, 'POST', `/api/agent/sessions/${createBody.session.id}/pi/stream`, { message: 'hello from pi' });

    expect(stream.status).toBe(200);
    const text = await stream.text();
    expect(text).toContain('"type":"pi_event"');
    expect(text).toContain('"type":"stdout","text":"public answer"');
    expect(text).not.toContain('"type":"stdout","text":"private scratchpad"');
    expect(text).not.toContain('"type":"debug"');
    expect(text).toContain('"answer":"public answer"');
  });

  it('emits startup debug timings when requested', async () => {
    mockLiveSandbox();
    vi.spyOn(CloudflareSandboxClient.prototype, 'streamCommand').mockImplementation(async (_id, command, onEvent) => {
      await onEvent({ stream: 'stdout', text: `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } })}\n` });
      return { command, stdout: '', parsed: { ok: true } };
    });

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const createBody = await created.json() as { session: { id: string } };
    const stream = await call(env, 'POST', `/api/agent/sessions/${createBody.session.id}/pi/stream`, { message: 'hello from pi', debug: true });

    expect(stream.status).toBe(200);
    const text = await stream.text();
    expect(text).toContain('"type":"debug"');
    expect(text).toContain('"phase":"session-ready"');
    expect(text).toContain('"phase":"stream-start"');
    expect(text).toContain('"phase":"first-byte"');
    expect(text).toContain('"phase":"first-pi-event"');
    expect(text).toContain('"phase":"first-thinking"');
  });

  it('uses the configured callback base for sandbox Board API calls', async () => {
    mockLiveSandbox();
    env.AGENT_CALLBACK_BASE_URL = 'https://board-callback.test/';
    let command = '';
    vi.spyOn(CloudflareSandboxClient.prototype, 'streamCommand').mockImplementation(async (_id, cmd, onEvent) => {
      command = cmd;
      await onEvent({ stream: 'stdout', text: 'ok' });
      return { command: cmd, stdout: 'ok', parsed: { ok: true } };
    });

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const createBody = await created.json() as { session: { id: string } };
    const stream = await call(env, 'POST', `/api/agent/sessions/${createBody.session.id}/pi/stream`, { message: 'hello from pi' });

    expect(stream.status).toBe(200);
    await stream.text();
    expect(command).toContain("BOARD_API_BASE='https://board-callback.test'");
    expect(command).toContain('node pi-runner.js');
    expect(command).not.toContain('tsx');
    expect(command).not.toContain("BOARD_API_BASE='http://test.local'");
  });

  it('uses workers.dev for the Access-gated production origin', async () => {
    mockLiveSandbox();
    let command = '';
    vi.spyOn(CloudflareSandboxClient.prototype, 'streamCommand').mockImplementation(async (_id, cmd, onEvent) => {
      command = cmd;
      await onEvent({ stream: 'stdout', text: 'ok' });
      return { command: cmd, stdout: 'ok', parsed: { ok: true } };
    });

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' }, 'https://board.thite.site');
    const createBody = await created.json() as { session: { id: string } };
    const stream = await call(env, 'POST', `/api/agent/sessions/${createBody.session.id}/pi/stream`, { message: 'hello from pi' }, 'https://board.thite.site');

    expect(stream.status).toBe(200);
    await stream.text();
    expect(command).toContain("BOARD_API_BASE='https://links.anishthite.workers.dev'");
  });

  it('executes commands through the live runtime and streams a persisted turn', async () => {
    mockLiveSandbox();

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const createBody = await created.json() as { session: { id: string } };
    const id = createBody.session.id;

    const exec = await call(env, 'POST', `/api/agent/sessions/${id}/exec`, { command: 'echo ok' });
    expect(exec.status).toBe(200);
    const execBody = await exec.json() as { result: { stdout: string }; event: { type: string } };
    expect(execBody.result.stdout).toBe('ok');
    expect(execBody.event.type).toBe('exec');

    const stream = await call(env, 'POST', `/api/agent/sessions/${id}/turns/stream`, { message: '$ echo ok' });
    expect(stream.status).toBe(200);
    const text = await stream.text();
    expect(text).toContain('"type":"turn"');
    expect(text).toContain('"type":"event"');
    expect(text).toContain('"type":"done"');

    const history = await call(env, 'GET', `/api/agent/sessions/${id}/history`);
    const historyBody = await history.json() as { turns: unknown[]; events: unknown[] };
    expect(historyBody.turns.length).toBeGreaterThanOrEqual(2);
    expect(historyBody.events.length).toBeGreaterThanOrEqual(3);
  });

  it('lets an agent session search and save notes through scoped tools', async () => {
    mockLiveSandbox();

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const createBody = await created.json() as { session: { id: string } };
    const id = createBody.session.id;

    const seed = await call(env, 'POST', '/api/notes', { text: 'Augmented reality research plan', tags: ['ar'] });
    expect(seed.status).toBe(201);
    await call(env, 'POST', '/api/notes', { text: 'Camera calibration checklist', tags: ['ar', 'hardware'] });
    await call(env, 'POST', '/api/notes', { text: 'Sourdough starter notes', tags: ['cooking'] });
    await setNoteDate('Augmented reality research plan', '2026-01-10T12:00:00Z');
    await setNoteDate('Camera calibration checklist', '2026-02-14T12:00:00Z');
    await setNoteDate('Sourdough starter notes', '2026-03-03T12:00:00Z');

    const search = await call(env, 'POST', `/api/agent/sessions/${id}/notes/search`, { query: 'augmented reality' });
    expect(search.status).toBe(200);
    const searchBody = await search.json() as { notes: Array<{ text: string; tags: string[]; createdAtIso: string; updatedAtIso: string; ageDays: number }>; grep: Array<{ path: string; line: number; snippet: string; updatedAtIso: string; ageDays: number }>; search: { scanned: number; totalMatches: number } };
    expect(searchBody.notes).toHaveLength(1);
    expect(searchBody.notes[0].text).toContain('Augmented reality');
    expect(searchBody.notes[0].tags).toContain('ar');
    expect(searchBody.notes[0].createdAtIso).toBe('2026-01-10T12:00:00.000Z');
    expect(searchBody.notes[0].updatedAtIso).toBe('2026-01-10T12:00:00.000Z');
    expect(searchBody.notes[0].ageDays).toBeGreaterThanOrEqual(0);
    expect(searchBody.grep[0].path).toMatch(/^links\//);
    expect(searchBody.grep[0].snippet).toContain('Augmented reality');
    expect(searchBody.grep[0].updatedAtIso).toBe('2026-01-10T12:00:00.000Z');
    expect(searchBody.grep[0].ageDays).toBeGreaterThanOrEqual(0);
    expect(searchBody.search.scanned).toBeGreaterThanOrEqual(3);
    expect(searchBody.search.totalMatches).toBeGreaterThanOrEqual(1);

    const patternSearch = await call(env, 'POST', `/api/agent/sessions/${id}/notes/search`, { pattern: 'calibration', limit: 10 });
    expect(patternSearch.status).toBe(200);
    const patternBody = await patternSearch.json() as { notes: Array<{ text: string }>; grep: Array<{ snippet: string }> };
    expect(patternBody.notes.map((note) => note.text)).toEqual(['Camera calibration checklist']);
    expect(patternBody.grep[0].snippet).toContain('calibration');

    const tagSearch = await call(env, 'POST', `/api/agent/sessions/${id}/notes/search`, { query: 'tag:ar', limit: 50 });
    expect(tagSearch.status).toBe(200);
    const tagBody = await tagSearch.json() as { notes: Array<{ text: string; tags: string[] }> };
    expect(tagBody.notes.map((note) => note.text).sort()).toEqual(['Augmented reality research plan', 'Camera calibration checklist']);

    const dateSearch = await call(env, 'POST', `/api/agent/sessions/${id}/notes/search`, { query: '', updatedAfter: '2026-02-14', updatedBefore: '2026-02-14', limit: 50 });
    expect(dateSearch.status).toBe(200);
    const dateBody = await dateSearch.json() as { notes: Array<{ text: string }> };
    expect(dateBody.notes.map((note) => note.text)).toEqual(['Camera calibration checklist']);

    const createdSearch = await call(env, 'POST', `/api/agent/sessions/${id}/notes/search`, { query: '', createdBefore: '2026-02-01', limit: 50 });
    expect(createdSearch.status).toBe(200);
    const createdBody = await createdSearch.json() as { notes: Array<{ text: string }> };
    expect(createdBody.notes.map((note) => note.text)).toEqual(['Augmented reality research plan']);

    const latestSearch = await call(env, 'POST', `/api/agent/sessions/${id}/notes/search`, { query: 'reflect on my latest note', limit: 1 });
    expect(latestSearch.status).toBe(200);
    const latestBody = await latestSearch.json() as { notes: Array<{ text: string }> };
    expect(latestBody.notes.map((note) => note.text)).toEqual(['Sourdough starter notes']);

    const save = await call(env, 'POST', `/api/agent/sessions/${id}/notes`, { text: 'Saved by pi #agent', tags: ['summary'] });
    expect(save.status).toBe(201);
    const saveBody = await save.json() as { note: { text: string; tags: string } };
    expect(saveBody.note.text).toBe('Saved by pi');
    expect(JSON.parse(saveBody.note.tags)).toEqual(['summary', 'agent']);
  });

  it('finds similar notes with deterministic fallback when sandbox is missing', async () => {
    await call(env, 'POST', '/api/notes', { text: 'Augmented reality research plan', tags: ['ar', 'hardware'] });
    await call(env, 'POST', '/api/notes', { text: 'Sourdough starter notes', tags: ['cooking'] });

    const res = await call(env, 'POST', '/api/agent/similar-notes', { text: 'AR headset calibration idea', tags: ['ar'], limit: 4 });
    expect(res.status).toBe(200);
    const body = await res.json() as { source: string; notes: Array<{ text: string; tags: string[]; reason: string }> };
    expect(body.source).toBe('fallback');
    expect(body.notes.map((note) => note.text)).toContain('Augmented reality research plan');
    expect(body.notes.map((note) => note.text)).not.toContain('Sourdough starter notes');
    expect(body.notes[0].reason).toContain('#ar');
  });

  it('uses a hidden read-only sandbox session for similar notes', async () => {
    const seed = await call(env, 'POST', '/api/notes', { text: 'Robotics hand idea', tags: ['robotics'] });
    const seedBody = await seed.json() as { note: { uuid: string } };
    await call(env, 'POST', '/api/notes', { text: 'Bread recipe', tags: ['cooking'] });

    vi.spyOn(CloudflareSandboxClient.prototype, 'createSession').mockResolvedValue({
      providerSessionId: 'live-similar-session',
      status: 'ready',
      previewUrl: null,
      cwd: '/workspace',
      errorMessage: null,
    });
    vi.spyOn(CloudflareSandboxClient.prototype, 'streamCommand').mockImplementation(async (_id, command, onEvent) => {
      expect(command).toContain("BOARD_READONLY='1'");
      const event = {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: JSON.stringify({ items: [{ uuid: seedBody.note.uuid, reason: 'same robotics idea' }] }) },
      };
      await onEvent({ stream: 'stdout', text: `${JSON.stringify(event)}\n` });
      return { command, stdout: '', parsed: { ok: true } };
    });
    env.Sandbox = {};

    const res = await call(env, 'POST', '/api/agent/similar-notes', { text: 'robot hand prototype', tags: ['robotics'], limit: 3 });
    expect(res.status).toBe(200);
    const body = await res.json() as { source: string; notes: Array<{ uuid: string; reason: string }> };
    expect(body.source).toBe('sandbox');
    expect(body.notes).toEqual([{ uuid: seedBody.note.uuid, text: 'Robotics hand idea', tags: ['robotics'], createdAt: expect.any(Number), updatedAt: expect.any(Number), reason: 'same robotics idea' }]);

    const listed = await call(env, 'GET', '/api/agent/sessions');
    const listBody = await listed.json() as { sessions: Array<{ title: string | null }> };
    expect(listBody.sessions.map((session) => session.title)).not.toContain('__similar_notes__');
  });

  it('lists, stops, and deletes existing sessions', async () => {
    mockLiveSandbox('live-list-session');

    const created = await call(env, 'POST', '/api/agent/sessions', { title: 'board sandbox' });
    const createBody = await created.json() as { session: { id: string } };
    const id = createBody.session.id;
    await call(env, 'POST', `/api/agent/sessions/${id}/turns`, { role: 'user', kind: 'message', content: 'keep this conversation' });

    const listed = await call(env, 'GET', '/api/agent/sessions');
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { sessions: Array<{ id: string }> };
    expect(listBody.sessions.map((session) => session.id)).toContain(id);

    const stopped = await call(env, 'POST', `/api/agent/sessions/${id}/stop`, {});
    expect(stopped.status).toBe(200);
    const stopBody = await stopped.json() as { ok: true; session: { status: string; deletedAt: number | null } };
    expect(stopBody.ok).toBe(true);
    expect(stopBody.session.status).toBe('stopped');
    expect(stopBody.session.deletedAt).toBeNull();

    const fetched = await call(env, 'GET', `/api/agent/sessions/${id}`);
    expect(fetched.status).toBe(200);

    const removed = await call(env, 'DELETE', `/api/agent/sessions/${id}`);
    expect(removed.status).toBe(200);
    const removeBody = await removed.json() as { ok: true; session: { status: string; deletedAt: number | null } };
    expect(removeBody.ok).toBe(true);
    expect(removeBody.session.status).toBe('stopped');
    expect(removeBody.session.deletedAt).toBeTypeOf('number');

    const missing = await call(env, 'GET', `/api/agent/sessions/${id}`);
    expect(missing.status).toBe(404);

    const listedAfterDelete = await call(env, 'GET', '/api/agent/sessions');
    const afterBody = await listedAfterDelete.json() as { sessions: Array<{ id: string }> };
    expect(afterBody.sessions.map((session) => session.id)).not.toContain(id);
  });
});

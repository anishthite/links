import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, asc, desc, eq, isNull, lt, ne } from 'drizzle-orm';

import type { Env, Variables } from '../env';
import { db, schema } from '../../db/client';
import { buildNoteInsert } from '../lib/note-write';
import { CLOUDFLARE_SANDBOX_PROVIDER, CloudflareSandboxClient, cloudflareSandboxErrorDebug } from '../lib/cloudflare-sandbox';
import { projectPiEntries } from '../lib/pi-project';
import { buildPiPromptCommand, buildPiRuntimeBootstrapCommand, redactPiPromptCommand } from '../lib/pi-runtime';
import { BEST_SIMILAR_RETRIEVAL_METHOD, buildSimilarCorpus, hasUsefulSimilarQuery, rankSimilarNotes } from '../lib/similar-note-retrieval';
import { noteDisplayTitle, notePreviewText, noteSearchText } from '../../src/lib/link-note';
import type { AgentSession, AgentThinkingLevel } from '../../src/lib/types';

export const agentRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ponytail: 15min idle = stale. Tune via AGENT_IDLE_TTL_MS env if it ever matters.
const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;
const SIMILAR_NOTES_TITLE = '__similar_notes__';
const GENERIC_AGENT_TITLE = 'links sandbox';
const DEFAULT_BEDROCK_AGENT_MODEL = 'us.anthropic.claude-opus-4-6-v1';
const DEFAULT_CODEX_AGENT_MODEL = 'gpt-5.5';
const DEFAULT_SIMILAR_NOTES_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const BOARD_WORKERS_DEV_ORIGIN = 'https://links.anishthite.workers.dev';
const CODEX_AUTH_SECRET_KEY = 'openai-codex-oauth-json';
const CODEX_DEVICE_SECRET_KEY = 'openai-codex-device-auth';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTH_BASE_URL = 'https://auth.openai.com';
const CODEX_DEVICE_USER_CODE_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const CODEX_DEVICE_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const CODEX_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/oauth/token`;
const CODEX_DEVICE_VERIFICATION_URI = `${CODEX_AUTH_BASE_URL}/codex/device`;
const CODEX_DEVICE_REDIRECT_URI = `${CODEX_AUTH_BASE_URL}/deviceauth/callback`;
const CODEX_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const CODEX_JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const MAX_STORED_JSON_DEPTH = 6;
const MAX_STORED_JSON_KEYS = 40;
const MAX_STORED_JSON_ITEMS = 40;
const MAX_STORED_STRING_CHARS = 16_000;
type PiModelProvider = 'amazon-bedrock' | 'openai-codex';
type PiModelSelection = { providerId: PiModelProvider; modelId: string };
const PI_MODELS = new Map<string, PiModelSelection>([
  ['openai-codex/gpt-5.5', { providerId: 'openai-codex', modelId: 'gpt-5.5' }],
  ['openai-codex/gpt-5.4', { providerId: 'openai-codex', modelId: 'gpt-5.4' }],
  ['amazon-bedrock/us.anthropic.claude-opus-4-6-v1', { providerId: 'amazon-bedrock', modelId: 'us.anthropic.claude-opus-4-6-v1' }],
  ['amazon-bedrock/us.anthropic.claude-opus-4-7', { providerId: 'amazon-bedrock', modelId: 'us.anthropic.claude-opus-4-7' }],
  ['amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0', { providerId: 'amazon-bedrock', modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' }],
  ['amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0', { providerId: 'amazon-bedrock', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' }],
]);
const PI_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const);

async function reapStaleSessions(env: Env, client: CloudflareSandboxClient | null): Promise<void> {
  if (!client) return; // no Sandbox binding → nothing to reap upstream
  const ttl = Number(env.AGENT_IDLE_TTL_MS) || DEFAULT_IDLE_TTL_MS;
  const cutoff = Date.now() - ttl;
  try {
    const d = db(env.DB);
    const stale = await d
      .select()
      .from(schema.agentSessions)
      .where(and(
        isNull(schema.agentSessions.deletedAt),
        lt(schema.agentSessions.updatedAt, cutoff),
      ))
      .all();
    const victims = stale.filter((r) => r.status !== 'stub' && r.providerSessionId);
    for (const row of victims) {
      if (!row.providerSessionId) continue;
      try {
        await client.deleteSession(row.providerSessionId);
      } catch (err) {
        console.warn('[agent] reap deleteSession failed', row.id, err);
      }
      const now = Date.now();
      await d.update(schema.agentSessions)
        .set({ status: 'stopped', updatedAt: now })
        .where(eq(schema.agentSessions.id, row.id))
        .run();
    }
    if (victims.length) console.log(`[agent] reaped ${victims.length} idle sandbox(es)`);
  } catch (err) {
    console.warn('[agent] reap failed', err);
  }
}

agentRoutes.get('/codex-auth', async (c) => {
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const status = await codexAuthStatus(db(c.env.DB), c.env, ownerEmail);
    return c.json(status);
  } catch (err) {
    console.error('[agent] codex auth status failed', err);
    return c.json({ error: 'codex auth status failed', detail: String(err) }, 500);
  }
});

agentRoutes.post('/codex-auth', async (c) => {
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const body = (await c.req.json().catch(() => ({}))) as { json?: unknown };
    const raw = typeof body.json === 'string' ? body.json : '';
    const normalized = normalizeCodexOAuthJson(raw);
    if (!normalized) return c.json({ error: 'valid openai-codex auth JSON required' }, 400);
    const d = db(c.env.DB);
    await upsertAgentSecret(d, ownerEmail, CODEX_AUTH_SECRET_KEY, normalized.valueJson);
    return c.json(await codexAuthStatus(d, c.env, ownerEmail));
  } catch (err) {
    console.error('[agent] codex auth rotate failed', err);
    return c.json({ error: 'codex auth rotate failed', detail: String(err) }, 500);
  }
});

agentRoutes.post('/codex-auth/device', async (c) => {
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const started = await startCodexDeviceAuth();
    const now = Date.now();
    const pending = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      deviceAuthId: started.deviceAuthId,
      userCode: started.userCode,
      intervalSeconds: started.intervalSeconds,
      expiresAt: now + CODEX_DEVICE_TIMEOUT_MS,
      createdAt: now,
    };
    await upsertAgentSecret(db(c.env.DB), ownerEmail, CODEX_DEVICE_SECRET_KEY, JSON.stringify(pending), now);
    return c.json({
      id: pending.id,
      userCode: pending.userCode,
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      intervalSeconds: pending.intervalSeconds,
      expiresAt: pending.expiresAt,
    });
  } catch (err) {
    console.error('[agent] codex device start failed', safeCodexError(err));
    return c.json({ error: 'codex device start failed', detail: safeCodexError(err) }, 502);
  }
});

agentRoutes.post('/codex-auth/device/:id', async (c) => {
  const ownerEmail = c.get('userEmail') || 'local-dev';
  const id = c.req.param('id');
  const d = db(c.env.DB);
  try {
    const pending = await getPendingCodexDeviceAuth(d, ownerEmail, id);
    if (!pending) return c.json({ status: 'expired' });
    if (Date.now() > pending.expiresAt) return c.json({ status: 'expired' });
    const token = await pollCodexDeviceAuth(pending);
    if (token.status === 'pending') return c.json({ status: 'pending', intervalSeconds: pending.intervalSeconds });
    const credentials = await exchangeCodexAuthorizationCode(token.authorizationCode, token.codeVerifier);
    await upsertAgentSecret(d, ownerEmail, CODEX_AUTH_SECRET_KEY, JSON.stringify(credentials));
    await upsertAgentSecret(d, ownerEmail, CODEX_DEVICE_SECRET_KEY, JSON.stringify({ id, status: 'complete', completedAt: Date.now() }));
    return c.json({ status: 'complete', auth: await codexAuthStatus(d, c.env, ownerEmail) });
  } catch (err) {
    console.error('[agent] codex device poll failed', safeCodexError(err));
    return c.json({ status: 'failed', error: safeCodexError(err) }, 502);
  }
});

agentRoutes.get('/sessions', async (c) => {
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const rows = await d.select()
      .from(schema.agentSessions)
      .where(and(
        eq(schema.agentSessions.ownerEmail, ownerEmail),
        isNull(schema.agentSessions.deletedAt),
        ne(schema.agentSessions.status, 'stub'),
      ))
      .orderBy(desc(schema.agentSessions.updatedAt))
      .limit(50)
      .all();
    const sessions: AgentSession[] = [];
    for (const row of rows.filter((item) => item.title !== SIMILAR_NOTES_TITLE)) {
      const title = await historyListTitle(d, row);
      if (!title) continue;
      sessions.push(toAgentSession({ ...row, title }));
    }
    return c.json({ sessions });
  } catch (err) {
    console.error('[agent] list sessions failed', err);
    return c.json({ error: 'list sessions failed', detail: String(err) }, 500);
  }
});

agentRoutes.post('/sessions', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : null;
    const ownerEmail = c.get('userEmail') || 'local-dev';
    const now = Date.now();
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const client = CloudflareSandboxClient.fromEnv(c.env);
    let row: typeof schema.agentSessions.$inferInsert;
    if (!client) {
      row = {
        id,
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
        providerSessionId: null,
        title,
        status: 'stopped',
        ownerEmail,
        previewUrl: null,
        cwd: null,
        errorMessage: 'Cloudflare Sandbox binding is not configured; saving notes chat history only.',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
    } else {
      let runtime: Awaited<ReturnType<CloudflareSandboxClient['createSession']>>;
      try {
        runtime = await client.createSession({ name: `board-${id}`, title });
      } catch (err) {
        const detail = String(err instanceof Error ? err.message : err);
        console.error('[agent] sandbox create failed', err);
        return c.json({ error: 'sandbox start failed', detail }, 503);
      }
      row = {
        id,
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
        providerSessionId: runtime.providerSessionId,
        title,
        status: runtime.status,
        ownerEmail,
        previewUrl: runtime.previewUrl,
        cwd: runtime.cwd,
        errorMessage: runtime.errorMessage ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
    }

    await db(c.env.DB).insert(schema.agentSessions).values(row);
    if (client) {
      try {
        c.executionCtx.waitUntil(reapStaleSessions(c.env, client));
      } catch {
        void reapStaleSessions(c.env, client).catch(() => null);
      }
    }
    return c.json({ session: toAgentSession(row) }, 201);
  } catch (err) {
    console.error('[agent] create session failed', err);
    return c.json({ error: 'create session failed', detail: String(err) }, 500);
  }
});

agentRoutes.get('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const row = await findOwnedSession(d, id, ownerEmail);
    if (!row) return c.json({ error: 'session not found' }, 404);
    const synced = await syncRemoteSession(d, row, CloudflareSandboxClient.fromEnv(c.env));
    return c.json({ session: toAgentSession(synced) });
  } catch (err) {
    console.error('[agent] get session failed', err);
    return c.json({ error: 'get session failed', detail: String(err) }, 500);
  }
});

agentRoutes.get('/sessions/:id/history', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const [turns, events, artifacts, piEntries] = await Promise.all([
      d.select().from(schema.agentTurns).where(eq(schema.agentTurns.sessionId, id)).orderBy(asc(schema.agentTurns.seq)).all(),
      d.select().from(schema.agentEvents).where(eq(schema.agentEvents.sessionId, id)).orderBy(asc(schema.agentEvents.seq)).all(),
      d.select().from(schema.agentArtifacts).where(eq(schema.agentArtifacts.sessionId, id)).orderBy(asc(schema.agentArtifacts.createdAt)).all(),
      d.select().from(schema.agentPiEntries).where(eq(schema.agentPiEntries.sessionId, id)).orderBy(asc(schema.agentPiEntries.piTimestamp)).all(),
    ]);
    return c.json({
      session: toAgentSession(session),
      turns: turns.map(toAgentTurn),
      events: events.map(toAgentEvent),
      artifacts: artifacts.map(toAgentArtifact),
      piEntries: piEntries.map(toAgentPiEntry),
    });
  } catch (err) {
    console.error('[agent] get history failed', err);
    return c.json({ error: 'get history failed', detail: String(err) }, 500);
  }
});

agentRoutes.post('/sessions/:id/turns', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown; kind?: unknown; content?: unknown };
    if (!isTurnRole(body.role)) return c.json({ error: 'role required' }, 400);
    if (!isTurnKind(body.kind)) return c.json({ error: 'kind required' }, 400);
    if (typeof body.content !== 'string' || body.content.trim().length === 0) return c.json({ error: 'content required' }, 400);
    const now = Date.now();
    const row = {
      sessionId: id,
      seq: await nextSeq(d, schema.agentTurns, id),
      role: body.role,
      kind: body.kind,
      content: body.content.slice(0, 200_000),
      createdAt: now,
    } satisfies typeof schema.agentTurns.$inferInsert;
    await d.insert(schema.agentTurns).values(row);
    const inserted = await d.select().from(schema.agentTurns)
      .where(and(eq(schema.agentTurns.sessionId, id), eq(schema.agentTurns.seq, row.seq))).get();
    await touchSession(d, id, now);
    return c.json({ turn: toAgentTurn(inserted!) }, 201);
  } catch (err) {
    console.error('[agent] create turn failed', err);
    return c.json({ error: 'create turn failed', detail: String(err) }, 500);
  }
});

agentRoutes.post('/sessions/:id/events', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { turnId?: unknown; type?: unknown; name?: unknown; payload?: unknown };
    if (typeof body.type !== 'string' || body.type.trim().length === 0) return c.json({ error: 'type required' }, 400);
    const now = Date.now();
    const row = {
      sessionId: id,
      turnId: typeof body.turnId === 'number' && Number.isFinite(body.turnId) ? Math.trunc(body.turnId) : null,
      seq: await nextSeq(d, schema.agentEvents, id),
      type: body.type.trim().slice(0, 80),
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : null,
      payloadJson: jsonForStorage(isPlainObject(body.payload) ? body.payload : {}),
      createdAt: now,
    } satisfies typeof schema.agentEvents.$inferInsert;
    await d.insert(schema.agentEvents).values(row);
    const inserted = await d.select().from(schema.agentEvents)
      .where(and(eq(schema.agentEvents.sessionId, id), eq(schema.agentEvents.seq, row.seq))).get();
    await touchSession(d, id, now);
    return c.json({ event: toAgentEvent(inserted!) }, 201);
  } catch (err) {
    console.error('[agent] create event failed', err);
    return c.json({ error: 'create event failed', detail: String(err) }, 500);
  }
});

agentRoutes.post('/sessions/:id/artifacts', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { turnId?: unknown; kind?: unknown; pathOrKey?: unknown; title?: unknown; contentText?: unknown; metadata?: unknown };
    if (typeof body.kind !== 'string' || body.kind.trim().length === 0) return c.json({ error: 'kind required' }, 400);
    const now = Date.now();
    const row = {
      sessionId: id,
      turnId: typeof body.turnId === 'number' && Number.isFinite(body.turnId) ? Math.trunc(body.turnId) : null,
      kind: body.kind.trim().slice(0, 80),
      pathOrKey: typeof body.pathOrKey === 'string' && body.pathOrKey.trim() ? body.pathOrKey.trim().slice(0, 500) : null,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : null,
      contentText: typeof body.contentText === 'string' ? body.contentText.slice(0, 500_000) : null,
      metadataJson: JSON.stringify(isPlainObject(body.metadata) ? body.metadata : {}),
      createdAt: now,
    } satisfies typeof schema.agentArtifacts.$inferInsert;
    await d.insert(schema.agentArtifacts).values(row);
    const inserted = await d.select().from(schema.agentArtifacts)
      .where(and(eq(schema.agentArtifacts.sessionId, id), eq(schema.agentArtifacts.createdAt, now))).get();
    await touchSession(d, id, now);
    return c.json({ artifact: toAgentArtifact(inserted!) }, 201);
  } catch (err) {
    console.error('[agent] create artifact failed', err);
    return c.json({ error: 'create artifact failed', detail: String(err) }, 500);
  }
});

agentRoutes.post('/sessions/:id/pi-entries', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { entries?: unknown; session?: unknown };
    if (!Array.isArray(body.entries)) return c.json({ error: 'entries array required' }, 400);
    if (body.entries.length > 200) return c.json({ error: 'too many entries' }, 400);
    const now = Date.now();
    const rows = body.entries.map((entry) => normalizePiEntry(id, entry, now)).filter((row): row is typeof schema.agentPiEntries.$inferInsert => !!row);
    if (rows.length === 0) return c.json({ imported: 0 });
    for (const row of rows) {
      await d.insert(schema.agentPiEntries).values(row).onConflictDoNothing().run();
    }
    const imported = await d.select().from(schema.agentPiEntries).where(eq(schema.agentPiEntries.sessionId, id)).all();
    const projected = await projectPiEntries(d, id, imported);
    const last = rows[rows.length - 1]!;
    await d.update(schema.agentSessions)
      .set({ ...piSessionPatch(body.session), piLeafEntryId: last.piEntryId, updatedAt: now })
      .where(eq(schema.agentSessions.id, id))
      .run();
    return c.json({ imported: rows.length, projected });
  } catch (err) {
    console.error('[agent] import pi entries failed', err);
    return c.json({ error: 'import pi entries failed', detail: String(err) }, 500);
  }
});

agentRoutes.post('/sessions/:id/bootstrap', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const command = buildPiRuntimeBootstrapCommand();
    const client = CloudflareSandboxClient.fromEnv(c.env);
    if (!client) return c.json({ error: 'sandbox unavailable', detail: 'Cloudflare Sandbox binding is not configured' }, 503);
    const live = await syncRemoteSession(d, session, client);
    if (live.status !== 'ready' || !live.providerSessionId) {
      return c.json({ error: 'session not ready', detail: `sandbox is ${live.status}; refresh in a few seconds`, session: toAgentSession(live) }, 409);
    }
    const result = await client.runCommand(live.providerSessionId, command);
    const now = Date.now();
    const event = await appendEvent(d, id, {
      type: 'bootstrap',
      name: 'pi-runtime',
      payload: { command, stdout: result.stdout, parsed: result.parsed },
      createdAt: now,
    });
    await touchSession(d, id, now);
    return c.json({ result, event: toAgentEvent(event) });
  } catch (err) {
    console.error('[agent] bootstrap failed', err);
    return c.json({ error: 'bootstrap failed', detail: String(err), debug: cloudflareSandboxErrorDebug(err) }, 500);
  }
});

agentRoutes.post('/sessions/:id/pi/stream', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  const body = (await c.req.json().catch(() => ({}))) as { message?: unknown; workdir?: unknown; modelId?: unknown; thinkingLevel?: unknown; debug?: unknown };
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 200_000) : '';
  const debugEnabled = body.debug === true;
  const startedAt = Date.now();
  if (!message) return c.json({ error: 'message required' }, 400);

  return streamSSE(c, async (stream) => {
    const emit = (ev: Record<string, unknown>) => stream.writeSSE({ data: JSON.stringify(ev) });
    const emitStartupDebug = async (phase: string, extra: Record<string, unknown> = {}) => {
      if (!debugEnabled) return;
      await emit({ type: 'debug', scope: 'startup', phase, elapsedMs: Date.now() - startedAt, ...extra });
    };
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) {
      await emit({ type: 'error', message: 'session not found' });
      return;
    }
    try {
      const client = CloudflareSandboxClient.fromEnv(c.env);
      if (!client) {
        await emit({ type: 'error', message: 'Cloudflare Sandbox binding is not configured' });
        return;
      }
      const live = await syncRemoteSession(d, session, client);
      if (live.status !== 'ready' || !live.providerSessionId) {
        await emit({ type: 'error', message: `sandbox is ${live.status}; refresh in a few seconds` });
        return;
      }
      await emitStartupDebug('session-ready', { status: live.status });
      const now = Date.now();
      const userTurn = await appendTurn(d, id, { role: 'user', kind: 'message', content: message, createdAt: now });
      await emit({ type: 'turn', turn: toAgentTurn(userTurn) });
      await emitStartupDebug('turn-created');
      const bridgeToken = c.env.AGENT_BRIDGE_TOKEN || 'local-dev-bridge-token';
      const model = resolvePiModel(c.env, body.modelId);
      const openaiCodexOAuthJson = model.providerId === 'openai-codex' ? await resolveOpenAICodexOAuthJson(d, c.env, ownerEmail) : undefined;
      const thinkingLevel = normalizePiThinkingLevel(body.thinkingLevel);
      const command = buildPiPromptCommand({
        boardApiBase: agentCallbackBase(c.env, c.req.url),
        boardSessionId: id,
        boardToken: bridgeToken,
        boardOwner: ownerEmail,
        prompt: message,
        workdir: typeof body.workdir === 'string' ? body.workdir : live.cwd,
        llmProvider: model.providerId,
        llmModel: model.modelId,
        openaiCodexOAuthJson,
        awsRegion: c.env.AWS_REGION,
        awsAccessKeyId: c.env.AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        awsSessionToken: c.env.AWS_SESSION_TOKEN,
        awsBearerTokenBedrock: c.env.AWS_BEARER_TOKEN_BEDROCK,
        bedrockModelId: model.providerId === 'amazon-bedrock' ? model.modelId : undefined,
        thinkingLevel,
      });
      const safeCommand = redactPiPromptCommand(command);
      await emit({ type: 'status', message: 'running pi inside Cloudflare Sandbox…' });
      await emitStartupDebug('stream-start', { model: model.modelId, provider: model.providerId });
      const call = await appendEvent(d, id, { turnId: userTurn.id, type: 'tool_call', name: 'pi', payload: { command: safeCommand }, createdAt: Date.now() });
      await emit({ type: 'event', event: toAgentEvent(call) });
      let answer = '';
      let fallbackAnswer = '';
      let lineBuffer = '';
      let sawFirstByte = false;
      let sawFirstPiEvent = false;
      let sawFirstThinking = false;
      const handlePiStdout = async (text: string) => {
        lineBuffer += text;
        let nl = lineBuffer.indexOf('\n');
        while (nl >= 0) {
          const line = lineBuffer.slice(0, nl);
          lineBuffer = lineBuffer.slice(nl + 1);
          const piEvent = safeJsonObjectOrNull(line);
          if (!piEvent) {
            if (line.trim()) await emit({ type: 'raw', stream: 'stdout', text: `${line}\n` });
            nl = lineBuffer.indexOf('\n');
            continue;
          }
          if (!sawFirstPiEvent) {
            sawFirstPiEvent = true;
            await emitStartupDebug('first-pi-event');
          }
          await emit({ type: 'pi_event', event: piEvent });
          const assistantEvent = isPlainObject(piEvent.assistantMessageEvent) ? piEvent.assistantMessageEvent : null;
          const assistantType = typeof assistantEvent?.type === 'string' ? assistantEvent.type : '';
          if (!sawFirstThinking && assistantType.includes('thinking')) {
            sawFirstThinking = true;
            await emitStartupDebug('first-thinking', { assistantType });
          }
          const delta = piTextDelta(piEvent);
          if (delta) {
            answer += delta;
            await emit({ type: 'stdout', text: delta });
          }
          fallbackAnswer = piAssistantText(piEvent) || fallbackAnswer;
          nl = lineBuffer.indexOf('\n');
        }
      };
      const result = await client.streamCommand(live.providerSessionId, command, async (event) => {
        if (!sawFirstByte) {
          sawFirstByte = true;
          await emitStartupDebug('first-byte', { stream: event.stream });
        }
        if (event.stream === 'stdout') await handlePiStdout(event.text);
        else if (event.stream === 'stderr') await emit({ type: 'stderr', text: event.text });
      });
      if (lineBuffer) await handlePiStdout('\n');
      const stdout = (answer || fallbackAnswer || result.stdout).trim() || '(pi completed with no output)';
      const toolResult = await appendEvent(d, id, { turnId: userTurn.id, type: 'tool_result', name: 'pi', payload: { stdout, parsed: result.parsed, rawStdout: result.stdout }, createdAt: Date.now() });
      await emit({ type: 'event', event: toAgentEvent(toolResult) });
      const assistant = await findMessageTurn(d, id, 'assistant', stdout)
        ?? await appendTurn(d, id, { role: 'assistant', kind: 'message', content: stdout, createdAt: Date.now() });
      await touchSession(d, id, Date.now());
      await emitStartupDebug('done');
      await emit({ type: 'done', turn: toAgentTurn(assistant), answer: stdout });
    } catch (err) {
      const detail = String(err instanceof Error ? err.message : err);
      const debug = cloudflareSandboxErrorDebug(err);
      await appendEvent(d, id, { type: 'error', name: 'pi_stream', payload: { message: detail, debug }, createdAt: Date.now() }).catch(() => null);
      await emitStartupDebug('error', { message: detail.slice(0, 200) });
      await emit({ type: 'error', message: detail.slice(0, 500), debug });
    }
  });
});

agentRoutes.post('/sessions/:id/exec', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { command?: unknown };
    if (typeof body.command !== 'string' || body.command.trim().length === 0) return c.json({ error: 'command required' }, 400);
    const command = body.command.trim().slice(0, 16_000);
    const client = CloudflareSandboxClient.fromEnv(c.env);
    if (!client) return c.json({ error: 'sandbox unavailable', detail: 'Cloudflare Sandbox binding is not configured' }, 503);
    const live = await syncRemoteSession(d, session, client);
    if (live.status !== 'ready' || !live.providerSessionId) {
      return c.json({ error: 'session not ready', detail: `sandbox is ${live.status}; refresh in a few seconds`, session: toAgentSession(live) }, 409);
    }
    const result = await client.runCommand(live.providerSessionId, command);
    const now = Date.now();
    const event = await appendEvent(d, id, {
      type: 'exec',
      name: command.split(/\s+/, 1)[0] || 'command',
      payload: { command, stdout: result.stdout, parsed: result.parsed },
      createdAt: now,
    });
    await touchSession(d, id, now);
    return c.json({ result, event: toAgentEvent(event) });
  } catch (err) {
    console.error('[agent] exec failed', err);
    return c.json({ error: 'exec failed', detail: String(err), debug: cloudflareSandboxErrorDebug(err) }, 500);
  }
});

agentRoutes.post('/sessions/:id/turns/stream', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  const body = (await c.req.json().catch(() => ({}))) as { message?: unknown; command?: unknown };
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 200_000) : '';
  const command = typeof body.command === 'string' && body.command.trim()
    ? body.command.trim().slice(0, 16_000)
    : message.startsWith('$ ')
      ? message.slice(2).trim().slice(0, 16_000)
      : `printf %s ${shellQuote(message || 'hello from sandbox')}`;
  if (!message) return c.json({ error: 'message required' }, 400);

  return streamSSE(c, async (stream) => {
    const emit = (ev: Record<string, unknown>) => stream.writeSSE({ data: JSON.stringify(ev) });
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) {
      await emit({ type: 'error', message: 'session not found' });
      return;
    }
    try {
      const client = CloudflareSandboxClient.fromEnv(c.env);
      if (!client) {
        await emit({ type: 'error', message: 'Cloudflare Sandbox binding is not configured' });
        return;
      }
      const live = await syncRemoteSession(d, session, client);
      if (live.status !== 'ready' || !live.providerSessionId) {
        await emit({ type: 'error', message: `sandbox is ${live.status}; refresh in a few seconds` });
        return;
      }
      const now = Date.now();
      const userTurn = await appendTurn(d, id, { role: 'user', kind: 'message', content: message, createdAt: now });
      await emit({ type: 'turn', turn: toAgentTurn(userTurn) });
      await emit({ type: 'status', message: 'running sandbox command…' });
      const started = await appendEvent(d, id, {
        turnId: userTurn.id,
        type: 'tool_call',
        name: 'shell',
        payload: { command },
        createdAt: Date.now(),
      });
      await emit({ type: 'event', event: toAgentEvent(started) });

      let streamed = '';
      const result = await client.streamCommand(live.providerSessionId, command, async (event) => {
        if (event.stream === 'stdout' || event.stream === 'stderr') {
          streamed += event.text;
          await emit({ type: event.stream, text: event.text });
        }
      });
      const stdout = (streamed || result.stdout).trim() || '(command completed with no output)';
      const finished = await appendEvent(d, id, {
        turnId: userTurn.id,
        type: 'tool_result',
        name: 'shell',
        payload: { command, stdout, parsed: result.parsed },
        createdAt: Date.now(),
      });
      await emit({ type: 'event', event: toAgentEvent(finished) });
      if (!streamed) await emit({ type: 'stdout', text: stdout });
      const assistant = await appendTurn(d, id, {
        role: 'assistant',
        kind: 'message',
        content: stdout,
        createdAt: Date.now(),
      });
      await touchSession(d, id, Date.now());
      await emit({ type: 'done', turn: toAgentTurn(assistant), answer: assistant.content });
    } catch (err) {
      const detail = String(err instanceof Error ? err.message : err);
      const debug = cloudflareSandboxErrorDebug(err);
      await appendEvent(d, id, { type: 'error', name: 'turn_stream', payload: { message: detail, debug }, createdAt: Date.now() }).catch(() => null);
      await emit({ type: 'error', message: detail.slice(0, 500), debug });
    }
  });
});

agentRoutes.post('/similar-notes', async (c) => {
  const ownerEmail = c.get('userEmail') || 'local-dev';
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; tags?: unknown; limit?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 8_000) : '';
  if (!text) return c.json({ error: 'text required' }, 400);
  const tags = normalizeSimilarTags(body.tags);
  const limit = clampSimilarLimit(body.limit);
  const d = db(c.env.DB);
  if (!hasUsefulSimilarQuery(text, tags)) {
    return c.json({ notes: [], source: 'too-short' });
  }

  const fallback = async () => c.json({ notes: await fallbackSimilarNotes(d, text, tags, limit), source: 'fallback' });
  const client = CloudflareSandboxClient.fromEnv(c.env);
  if (!client) return fallback();

  try {
    const session = await ensureSimilarNotesSession(d, c.env, ownerEmail, client);
    if (session.status !== 'ready' || !session.providerSessionId) return fallback();

    const prompt = buildSimilarNotesPrompt(text, tags, limit);
    const model = resolvePiModel(c.env, c.env.SIMILAR_NOTES_MODEL_ID || c.env.TAGGER_MODEL_ID, { 'amazon-bedrock': DEFAULT_SIMILAR_NOTES_MODEL });
    const openaiCodexOAuthJson = model.providerId === 'openai-codex' ? await resolveOpenAICodexOAuthJson(d, c.env, ownerEmail) : undefined;
    const command = buildPiPromptCommand({
      boardApiBase: agentCallbackBase(c.env, c.req.url),
      boardSessionId: session.id,
      boardToken: c.env.AGENT_BRIDGE_TOKEN || 'local-dev-bridge-token',
      boardOwner: ownerEmail,
      prompt,
      workdir: session.cwd,
      llmProvider: model.providerId,
      llmModel: model.modelId,
      openaiCodexOAuthJson,
      awsRegion: c.env.AWS_REGION,
      awsAccessKeyId: c.env.AWS_ACCESS_KEY_ID,
      awsSecretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
      awsSessionToken: c.env.AWS_SESSION_TOKEN,
      awsBearerTokenBedrock: c.env.AWS_BEARER_TOKEN_BEDROCK,
      bedrockModelId: model.providerId === 'amazon-bedrock' ? model.modelId : undefined,
      thinkingLevel: 'minimal',
      readOnly: true,
    });

    let answer = '';
    let fallbackAnswer = '';
    let lineBuffer = '';
    const handleStdout = (chunk: string) => {
      lineBuffer += chunk;
      let nl = lineBuffer.indexOf('\n');
      while (nl >= 0) {
        const line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        const piEvent = safeJsonObjectOrNull(line);
        if (piEvent) {
          answer += piTextDelta(piEvent);
          fallbackAnswer = piAssistantText(piEvent) || fallbackAnswer;
        }
        nl = lineBuffer.indexOf('\n');
      }
    };
    const result = await client.streamCommand(session.providerSessionId, command, async (event) => {
      if (event.stream === 'stdout') handleStdout(event.text);
    });
    if (lineBuffer) handleStdout('\n');

    const parsed = parseSimilarNotesAnswer(answer || fallbackAnswer || result.stdout);
    const notes = await notesFromSimilarItems(d, parsed, limit);
    await touchSession(d, session.id, Date.now());
    return notes.length > 0 ? c.json({ notes, source: 'sandbox' }) : fallback();
  } catch (err) {
    console.warn('[agent] similar notes sandbox failed; using fallback', err);
    return fallback();
  }
});

agentRoutes.post('/sessions/:id/notes/search', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { query?: unknown; pattern?: unknown; limit?: unknown; context?: unknown; createdAfter?: unknown; createdBefore?: unknown; updatedAfter?: unknown; updatedBefore?: unknown };
    const query = (typeof body.query === 'string' ? body.query : typeof body.pattern === 'string' ? body.pattern : '').trim();
    const grepQuery = normalizeNoteSearchQuery(query);
    const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.max(1, Math.min(100, Math.trunc(body.limit))) : 40;
    const context = typeof body.context === 'number' && Number.isFinite(body.context) ? Math.max(0, Math.min(3, Math.trunc(body.context))) : 0;
    const dates = parseNoteDateBounds(body);
    const now = Date.now();
    const rows = await d.select().from(schema.notes).orderBy(desc(schema.notes.updatedAt)).all();
    const scanned = rows
      .map((note) => ({ note, tags: safeTags(note.tags) }))
      .filter((item) => noteInDateRange(item.note, dates));
    const results = scanned
      .map((item) => ({ item, matches: noteGrepMatches(item.note, item.tags, grepQuery, context, now) }))
      .filter((result) => result.matches.length > 0);
    const found = results.slice(0, limit);
    const notes = found.map(({ item }) => ({
      uuid: item.note.uuid,
      text: item.note.text,
      tags: item.tags,
      createdAt: item.note.createdAt,
      updatedAt: item.note.updatedAt,
      sourceUrl: item.note.sourceUrl,
      sourceTitle: item.note.sourceTitle,
      sourceDescription: item.note.sourceDescription,
      sourceSiteName: item.note.sourceSiteName,
      sourceContentText: item.note.sourceContentText,
      ...noteFreshness(item.note, now),
    }));
    const grep = found.flatMap(({ matches }) => matches.slice(0, 8)).slice(0, 120);
    const search = { query, scanned: scanned.length, matchedNotes: results.length, returnedNotes: notes.length, totalMatches: results.reduce((n, result) => n + result.matches.length, 0), context };
    await appendEvent(d, id, { type: 'tool_result', name: 'search_notes', payload: { ...search, ...dates }, createdAt: Date.now() });
    return c.json({ notes, grep, search });
  } catch (err) {
    console.error('[agent] notes search failed', err);
    return c.json({ error: 'notes search failed', detail: String(err) }, 500);
  }
});

agentRoutes.post('/sessions/:id/notes', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const session = await findOwnedSession(d, id, ownerEmail);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; tags?: unknown };
    if (typeof body.text !== 'string' || body.text.trim().length === 0) return c.json({ error: 'text required' }, 400);
    const note = buildNoteInsert(body.tags, body.text);
    await d.insert(schema.notes).values(note);
    await appendEvent(d, id, { type: 'tool_result', name: 'save_note', payload: { uuid: note.uuid, tags: safeTags(note.tags) }, createdAt: Date.now() });
    return c.json({ note: { ...note } }, 201);
  } catch (err) {
    console.error('[agent] note create failed', err);
    return c.json({ error: 'note create failed', detail: String(err) }, 500);
  }
});

agentRoutes.post('/sessions/:id/stop', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const row = await findOwnedSession(d, id, ownerEmail);
    if (!row) return c.json({ error: 'session not found' }, 404);
    const stopped = await stopSession(d, row, CloudflareSandboxClient.fromEnv(c.env));
    return c.json({ ok: true, session: toAgentSession(stopped) });
  } catch (err) {
    console.error('[agent] stop session failed', err);
    return c.json({ error: 'stop session failed', detail: String(err) }, 500);
  }
});

agentRoutes.delete('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const ownerEmail = c.get('userEmail') || 'local-dev';
  try {
    const d = db(c.env.DB);
    const row = await findOwnedSession(d, id, ownerEmail);
    if (!row) return c.json({ error: 'session not found' }, 404);
    const stopped = await stopSession(d, row, CloudflareSandboxClient.fromEnv(c.env));
    const now = Date.now();
    await d.update(schema.agentSessions)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.agentSessions.id, id))
      .run();
    return c.json({ ok: true, session: toAgentSession({ ...stopped, deletedAt: now, updatedAt: now }) });
  } catch (err) {
    console.error('[agent] delete session failed', err);
    return c.json({ error: 'delete session failed', detail: String(err) }, 500);
  }
});

async function stopSession(
  d: ReturnType<typeof db>,
  row: typeof schema.agentSessions.$inferSelect,
  client: CloudflareSandboxClient | null,
) {
  if (client && row.providerSessionId && row.status !== 'stub' && row.status !== 'stopped') {
    await client.deleteSession(row.providerSessionId);
  }
  const now = Date.now();
  const stopped = { ...row, status: 'stopped', updatedAt: now };
  await d.update(schema.agentSessions)
    .set({ status: 'stopped', updatedAt: now })
    .where(eq(schema.agentSessions.id, row.id))
    .run();
  return stopped;
}

async function syncRemoteSession(
  d: ReturnType<typeof db>,
  row: typeof schema.agentSessions.$inferSelect,
  client: CloudflareSandboxClient | null,
) {
  if (!client || !row.providerSessionId || row.status === 'stub' || row.status === 'stopped') return row;
  const runtime = await client.getSession(row.providerSessionId);
  const updatedAt = Date.now();
  const next = {
    ...row,
    providerSessionId: runtime.providerSessionId,
    status: runtime.status,
    previewUrl: runtime.previewUrl,
    cwd: runtime.cwd,
    errorMessage: runtime.errorMessage ?? null,
    updatedAt,
  };
  await d.update(schema.agentSessions)
    .set({
      providerSessionId: next.providerSessionId,
      status: next.status,
      previewUrl: next.previewUrl,
      cwd: next.cwd,
      errorMessage: next.errorMessage,
      updatedAt,
    })
    .where(eq(schema.agentSessions.id, row.id))
    .run();
  return next;
}

async function findOwnedSession(d: ReturnType<typeof db>, id: string, ownerEmail: string) {
  return d.select().from(schema.agentSessions).where(and(
    eq(schema.agentSessions.id, id),
    eq(schema.agentSessions.ownerEmail, ownerEmail),
    isNull(schema.agentSessions.deletedAt),
  )).get();
}

async function historyListTitle(d: ReturnType<typeof db>, row: typeof schema.agentSessions.$inferSelect): Promise<string | null> {
  const title = compactSessionTitle(row.title);
  if (title && title.toLowerCase() !== GENERIC_AGENT_TITLE && title.toLowerCase() !== 'board sandbox') return title;
  const turn = await d.select({ content: schema.agentTurns.content }).from(schema.agentTurns).where(and(
    eq(schema.agentTurns.sessionId, row.id),
    eq(schema.agentTurns.role, 'user'),
    eq(schema.agentTurns.kind, 'message'),
  )).orderBy(asc(schema.agentTurns.seq)).limit(1).get();
  return compactSessionTitle(turn?.content);
}

function compactSessionTitle(text: string | null | undefined): string | null {
  const title = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return title || null;
}

async function touchSession(d: ReturnType<typeof db>, id: string, now: number) {
  await d.update(schema.agentSessions).set({ updatedAt: now }).where(eq(schema.agentSessions.id, id)).run();
}

async function findMessageTurn(
  d: ReturnType<typeof db>,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
) {
  return d.select().from(schema.agentTurns).where(and(
    eq(schema.agentTurns.sessionId, sessionId),
    eq(schema.agentTurns.role, role),
    eq(schema.agentTurns.kind, 'message'),
    eq(schema.agentTurns.content, content),
  )).orderBy(desc(schema.agentTurns.seq)).get();
}

async function appendTurn(
  d: ReturnType<typeof db>,
  sessionId: string,
  input: { role: 'user' | 'assistant' | 'system'; kind: 'message' | 'status' | 'error' | 'summary'; content: string; createdAt: number },
) {
  const row = {
    sessionId,
    seq: await nextSeq(d, schema.agentTurns, sessionId),
    role: input.role,
    kind: input.kind,
    content: input.content,
    createdAt: input.createdAt,
  } satisfies typeof schema.agentTurns.$inferInsert;
  await d.insert(schema.agentTurns).values(row);
  const inserted = await d.select().from(schema.agentTurns)
    .where(and(eq(schema.agentTurns.sessionId, sessionId), eq(schema.agentTurns.seq, row.seq))).get();
  return inserted!;
}

async function appendEvent(
  d: ReturnType<typeof db>,
  sessionId: string,
  input: { turnId?: number | null; type: string; name?: string | null; payload?: Record<string, unknown>; createdAt: number },
) {
  const row = {
    sessionId,
    turnId: input.turnId ?? null,
    seq: await nextSeq(d, schema.agentEvents, sessionId),
    type: input.type,
    name: input.name ?? null,
    payloadJson: jsonForStorage(input.payload ?? {}),
    createdAt: input.createdAt,
  } satisfies typeof schema.agentEvents.$inferInsert;
  await d.insert(schema.agentEvents).values(row);
  const inserted = await d.select().from(schema.agentEvents)
    .where(and(eq(schema.agentEvents.sessionId, sessionId), eq(schema.agentEvents.seq, row.seq))).get();
  return inserted!;
}

async function nextSeq(
  d: ReturnType<typeof db>,
  table: typeof schema.agentTurns | typeof schema.agentEvents,
  sessionId: string,
): Promise<number> {
  const row = await d.select({ seq: table.seq })
    .from(table)
    .where(eq(table.sessionId, sessionId))
    .orderBy(desc(table.seq))
    .limit(1)
    .get();
  return (row?.seq ?? 0) + 1;
}

function jsonForStorage(value: unknown): string {
  return JSON.stringify(clampJsonValue(value, 0));
}

function clampJsonValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STORED_STRING_CHARS ? `${value.slice(0, MAX_STORED_STRING_CHARS)}\n…[truncated]` : value;
  if (depth >= MAX_STORED_JSON_DEPTH) return Array.isArray(value) ? ['…[truncated]'] : { _truncated: true };
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_STORED_JSON_ITEMS).map((item) => clampJsonValue(item, depth + 1));
    if (value.length > MAX_STORED_JSON_ITEMS) items.push(`…[${value.length - MAX_STORED_JSON_ITEMS} more items]`);
    return items;
  }
  if (!isPlainObject(value)) return String(value);
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, entryValue] of entries.slice(0, MAX_STORED_JSON_KEYS)) out[key] = clampJsonValue(entryValue, depth + 1);
  if (entries.length > MAX_STORED_JSON_KEYS) out._truncated = `${entries.length - MAX_STORED_JSON_KEYS} more keys`;
  return out;
}

function safeTags(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

type SimilarNoteResult = {
  uuid: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceDescription?: string;
  sourceSiteName?: string;
  sourceContentText?: string;
  reason: string;
};
type SimilarItem = { uuid: string; reason: string };

async function ensureSimilarNotesSession(
  d: ReturnType<typeof db>,
  env: Env,
  ownerEmail: string,
  client: CloudflareSandboxClient,
) {
  const existing = await d.select().from(schema.agentSessions).where(and(
    eq(schema.agentSessions.ownerEmail, ownerEmail),
    eq(schema.agentSessions.title, SIMILAR_NOTES_TITLE),
    isNull(schema.agentSessions.deletedAt),
  )).orderBy(desc(schema.agentSessions.updatedAt)).get();
  if (existing && existing.status !== 'stopped' && existing.status !== 'error') return syncRemoteSession(d, existing, client);
  if (existing) {
    await d.update(schema.agentSessions)
      .set({ deletedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(schema.agentSessions.id, existing.id))
      .run();
  }

  const now = Date.now();
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const runtime = await client.createSession({ name: `board-similar-${id}`, title: SIMILAR_NOTES_TITLE });
  const row = {
    id,
    provider: CLOUDFLARE_SANDBOX_PROVIDER,
    providerSessionId: runtime.providerSessionId,
    title: SIMILAR_NOTES_TITLE,
    status: runtime.status,
    ownerEmail,
    previewUrl: runtime.previewUrl,
    cwd: runtime.cwd,
    errorMessage: runtime.errorMessage ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  } satisfies typeof schema.agentSessions.$inferInsert;
  await d.insert(schema.agentSessions).values(row);
  return row;
}

function buildSimilarNotesPrompt(text: string, tags: string[], limit: number): string {
  return [
    'Find saved Board notes that are genuinely related to this draft note.',
    'Use search_notes 1-5 times with concrete phrases, synonyms, and tags from the draft.',
    `Return at most ${limit} notes. Only return UUIDs that appeared in search_notes results.`,
    'Return JSON only, no markdown: {"items":[{"uuid":"...","reason":"short why relevant"}]}',
    '',
    `Draft tags: ${tags.length ? tags.map((tag) => `#${tag}`).join(' ') : '(none)'}`,
    'Draft text:',
    text,
  ].join('\n');
}

function parseSimilarNotesAnswer(text: string): SimilarItem[] {
  const raw = text.trim();
  if (!raw) return [];
  const candidates = [raw, raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) continue;
      return parsed.items.map((item): SimilarItem | null => {
        if (!isPlainObject(item) || typeof item.uuid !== 'string') return null;
        return { uuid: item.uuid, reason: typeof item.reason === 'string' ? item.reason.slice(0, 180) : '' };
      }).filter((item): item is SimilarItem => !!item);
    } catch {
      // try next candidate
    }
  }
  return [];
}

async function notesFromSimilarItems(d: ReturnType<typeof db>, items: SimilarItem[], limit: number): Promise<SimilarNoteResult[]> {
  if (items.length === 0) return [];
  const wanted: SimilarItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.uuid)) continue;
    seen.add(item.uuid);
    wanted.push(item);
    if (wanted.length >= limit) break;
  }
  const rows = await d.select().from(schema.notes).all();
  const byUuid = new Map(rows.map((row) => [row.uuid, row]));
  const out: SimilarNoteResult[] = [];
  for (const item of wanted) {
    const note = byUuid.get(item.uuid);
    if (!note) continue;
    out.push({
      uuid: note.uuid,
      text: note.text,
      tags: safeTags(note.tags),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      ...optionalSourceFields(note),
      reason: item.reason || 'related note',
    });
  }
  return out;
}

async function fallbackSimilarNotes(d: ReturnType<typeof db>, text: string, tags: string[], limit: number): Promise<SimilarNoteResult[]> {
  const rows = await d.select().from(schema.notes).orderBy(desc(schema.notes.updatedAt)).all();
  const corpus = buildSimilarCorpus(rows.map((note) => ({
    uuid: note.uuid,
    text: note.text,
    tags: safeTags(note.tags),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    sourceUrl: note.sourceUrl,
    sourceTitle: note.sourceTitle,
    sourceDescription: note.sourceDescription,
    sourceSiteName: note.sourceSiteName,
    sourceContentText: note.sourceContentText,
  })));
  return rankSimilarNotes(corpus, { text, tags }, BEST_SIMILAR_RETRIEVAL_METHOD, limit).map((note) => ({
    uuid: note.uuid,
    text: note.text,
    tags: note.tags,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    ...optionalSourceFields(note),
    reason: note.reason,
  }));
}

function optionalSourceFields(note: { sourceUrl?: string | null; sourceTitle?: string | null; sourceDescription?: string | null; sourceSiteName?: string | null; sourceContentText?: string | null }) {
  const out: Record<string, string> = {};
  if (note.sourceUrl) out.sourceUrl = note.sourceUrl;
  if (note.sourceTitle) out.sourceTitle = note.sourceTitle;
  if (note.sourceDescription) out.sourceDescription = note.sourceDescription;
  if (note.sourceSiteName) out.sourceSiteName = note.sourceSiteName;
  if (note.sourceContentText) out.sourceContentText = note.sourceContentText;
  return out;
}

function normalizeSimilarTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim().replace(/^#/, '').toLowerCase()).filter(Boolean).slice(0, 12)
    : [];
}

function clampSimilarLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(12, Math.trunc(value))) : 8;
}

type NoteDateBounds = { createdAfter?: number; createdBefore?: number; updatedAfter?: number; updatedBefore?: number };

type NoteDated = { createdAt: number; updatedAt: number };

function parseNoteDateBounds(body: { createdAfter?: unknown; createdBefore?: unknown; updatedAfter?: unknown; updatedBefore?: unknown }): NoteDateBounds {
  return {
    createdAfter: parseDateBound(body.createdAfter, false),
    createdBefore: parseDateBound(body.createdBefore, true),
    updatedAfter: parseDateBound(body.updatedAfter, false),
    updatedBefore: parseDateBound(body.updatedBefore, true),
  };
}

function parseDateBound(value: unknown, endOfDay: boolean): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return undefined;
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? ms + 86_400_000 - 1 : ms;
}

function noteInDateRange(note: NoteDated, bounds: NoteDateBounds): boolean {
  if (bounds.createdAfter !== undefined && note.createdAt < bounds.createdAfter) return false;
  if (bounds.createdBefore !== undefined && note.createdAt > bounds.createdBefore) return false;
  if (bounds.updatedAfter !== undefined && note.updatedAt < bounds.updatedAfter) return false;
  if (bounds.updatedBefore !== undefined && note.updatedAt > bounds.updatedBefore) return false;
  return true;
}

function normalizeNoteSearchQuery(query: string): string {
  return noteRequestsRecent(query) ? '' : query;
}

function noteRequestsRecent(query: string): boolean {
  const normalized = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(reflect|reflection|summarize|summary|review|show|find|get|pull|read|open|look|talk|discuss|think|about|on|at|into|please|can|could|would|should|you|me|my|our|the|a|an|what|is|are|do|does|did|tell)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ['latest note', 'latest notes', 'newest note', 'newest notes', 'recent note', 'recent notes', 'most recent note', 'most recent notes'].includes(normalized);
}

function noteGrepMatches(note: { uuid: string; text: string; createdAt: number; updatedAt: number; sourceUrl?: string | null; sourceTitle?: string | null; sourceDescription?: string | null; sourceSiteName?: string | null; sourceContentText?: string | null }, tags: string[], query: string, context: number, now: number) {
  const q = query.trim().toLowerCase();
  const terms = q.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const tagSet = new Set(tags.map((tag) => tag.toLowerCase()));
  const forcedTags = [...q.matchAll(/(?:^|\s)(?:#|tags?:)([a-z0-9][a-z0-9_-]*)/g)].map((m) => m[1]!);
  if (forcedTags.length > 0) {
    if (!forcedTags.every((tag) => tagSet.has(tag))) return [];
    return [noteGrepMatch(note, tags, 0, tags.map((tag) => `#${tag}`).join(' ') || '(no tags)', [], [], now)];
  }

  const lines = noteSearchText(note).split(/\r?\n/);
  if (!q) return [noteGrepMatch(note, tags, 1, noteDisplayTitle(note) || firstNonBlank(lines) || note.text, [], [], now)];
  const haystack = `${noteSearchText(note)}\n${tags.map((tag) => `#${tag}`).join('\n')}`.toLowerCase();
  if (!haystack.includes(q) && !terms.every((term) => haystack.includes(term) || tagSet.has(term))) return [];

  const matches = lines.flatMap((line, index) => lineMatches(line, q, terms)
    ? [noteGrepMatch(note, tags, index + 1, line, contextLines(lines, index, -context), contextLines(lines, index, context), now)]
    : []);
  if (matches.length > 0) return matches;
  return [noteGrepMatch(note, tags, 1, notePreviewText(note, 220), [], [], now)];
}

function lineMatches(line: string, query: string, terms: string[]): boolean {
  const l = line.toLowerCase();
  return l.includes(query) || terms.some((term) => l.includes(term));
}

function noteGrepMatch(note: { uuid: string; createdAt: number; updatedAt: number }, tags: string[], line: number, snippet: string, before: string[], after: string[], now: number) {
  return { uuid: note.uuid, path: `links/${safeNoteFileSegment(note.uuid)}.md`, line, snippet: clipSnippet(snippet), before, after, tags, updatedAt: note.updatedAt, ...noteFreshness(note, now) };
}

function noteFreshness(note: { createdAt: number; updatedAt: number }, now: number) {
  return {
    createdAtIso: noteIso(note.createdAt),
    updatedAtIso: noteIso(note.updatedAt),
    ageDays: Math.max(0, Math.floor((now - note.updatedAt) / 86_400_000)),
  };
}

function noteIso(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

function contextLines(lines: string[], index: number, span: number): string[] {
  if (span === 0) return [];
  if (span < 0) return lines.slice(Math.max(0, index + span), index).map(clipSnippet);
  return lines.slice(index + 1, index + 1 + span).map(clipSnippet);
}

function firstNonBlank(lines: string[]): string {
  return lines.find((line) => line.trim()) || '';
}

function safeNoteFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || 'note';
}

function clipSnippet(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function upsertAgentSecret(d: ReturnType<typeof db>, ownerEmail: string, key: string, valueJson: string, updatedAt = Date.now()): Promise<void> {
  await d.insert(schema.agentSecrets)
    .values({ ownerEmail, key, valueJson, updatedAt })
    .onConflictDoUpdate({ target: [schema.agentSecrets.ownerEmail, schema.agentSecrets.key], set: { valueJson, updatedAt } })
    .run();
}

async function startCodexDeviceAuth(): Promise<{ deviceAuthId: string; userCode: string; intervalSeconds: number }> {
  const response = await fetch(CODEX_DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (!response.ok) throw new Error(`OpenAI device code request failed (${response.status})`);
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  const intervalSeconds = typeof json?.interval === 'string' ? Number(json.interval.trim()) : Number(json?.interval ?? 5);
  const deviceAuthId = typeof json?.device_auth_id === 'string' ? json.device_auth_id : '';
  const userCode = typeof json?.user_code === 'string' ? json.user_code : '';
  if (!deviceAuthId || !userCode || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error('OpenAI device code response was invalid');
  }
  return { deviceAuthId, userCode, intervalSeconds };
}

async function pollCodexDeviceAuth(pending: CodexDeviceAuthState): Promise<{ status: 'pending' } | { status: 'complete'; authorizationCode: string; codeVerifier: string }> {
  const response = await fetch(CODEX_DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
  });
  if (response.ok) {
    const json = await response.json().catch(() => null) as Record<string, unknown> | null;
    const authorizationCode = typeof json?.authorization_code === 'string' ? json.authorization_code : '';
    const codeVerifier = typeof json?.code_verifier === 'string' ? json.code_verifier : '';
    if (!authorizationCode || !codeVerifier) throw new Error('OpenAI device auth token response was invalid');
    return { status: 'complete', authorizationCode, codeVerifier };
  }
  if (response.status === 403 || response.status === 404) return { status: 'pending' };
  const text = await response.text().catch(() => '');
  const error = safeJsonErrorCode(text);
  if (error === 'deviceauth_authorization_pending' || error === 'slow_down') return { status: 'pending' };
  throw new Error(`OpenAI device auth poll failed (${response.status})`);
}

async function exchangeCodexAuthorizationCode(code: string, codeVerifier: string): Promise<Record<string, unknown>> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: CODEX_DEVICE_REDIRECT_URI,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI token exchange failed (${response.status})`);
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  const access = typeof json?.access_token === 'string' ? json.access_token : '';
  const refresh = typeof json?.refresh_token === 'string' ? json.refresh_token : '';
  const expiresIn = typeof json?.expires_in === 'number' ? json.expires_in : Number(json?.expires_in);
  if (!access || !refresh || !Number.isFinite(expiresIn)) throw new Error('OpenAI token exchange response was invalid');
  const auth: Record<string, unknown> = { type: 'oauth', access, refresh, expires: Date.now() + expiresIn * 1000 };
  const accountId = getCodexAccountId(access);
  if (accountId) auth.accountId = accountId;
  return auth;
}

async function getPendingCodexDeviceAuth(d: ReturnType<typeof db>, ownerEmail: string, id: string): Promise<CodexDeviceAuthState | null> {
  const stored = await d.select().from(schema.agentSecrets)
    .where(and(eq(schema.agentSecrets.ownerEmail, ownerEmail), eq(schema.agentSecrets.key, CODEX_DEVICE_SECRET_KEY)))
    .get();
  const parsed = safeJsonObject(stored?.valueJson);
  if (parsed.id !== id) return null;
  const state = parseCodexDeviceAuthState(parsed);
  return state;
}

function parseCodexDeviceAuthState(v: Record<string, unknown>): CodexDeviceAuthState | null {
  const id = typeof v.id === 'string' ? v.id : '';
  const deviceAuthId = typeof v.deviceAuthId === 'string' ? v.deviceAuthId : '';
  const userCode = typeof v.userCode === 'string' ? v.userCode : '';
  const intervalSeconds = typeof v.intervalSeconds === 'number' ? v.intervalSeconds : Number(v.intervalSeconds);
  const expiresAt = typeof v.expiresAt === 'number' ? v.expiresAt : Number(v.expiresAt);
  if (!id || !deviceAuthId || !userCode || !Number.isFinite(intervalSeconds) || !Number.isFinite(expiresAt)) return null;
  return { id, deviceAuthId, userCode, intervalSeconds, expiresAt };
}

function safeJsonErrorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string') return error;
    if (isPlainObject(error) && typeof error.code === 'string') return error.code;
  } catch {
    // ignore
  }
  return undefined;
}

function getCodexAccountId(accessToken: string): string | null {
  try {
    const [, payload] = accessToken.split('.');
    if (!payload) return null;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const json = JSON.parse(atob(b64)) as Record<string, unknown>;
    const auth = json[CODEX_JWT_CLAIM_PATH];
    if (!isPlainObject(auth)) return null;
    return typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id ? auth.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

function safeCodexError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type CodexDeviceAuthState = {
  id: string;
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
};

async function resolveOpenAICodexOAuthJson(d: ReturnType<typeof db>, env: Env, ownerEmail: string): Promise<string | undefined> {
  const stored = await d.select().from(schema.agentSecrets)
    .where(and(eq(schema.agentSecrets.ownerEmail, ownerEmail), eq(schema.agentSecrets.key, CODEX_AUTH_SECRET_KEY)))
    .get();
  return stored?.valueJson || env.OPENAI_CODEX_OAUTH_JSON;
}

async function codexAuthStatus(d: ReturnType<typeof db>, env: Env, ownerEmail: string) {
  const stored = await d.select().from(schema.agentSecrets)
    .where(and(eq(schema.agentSecrets.ownerEmail, ownerEmail), eq(schema.agentSecrets.key, CODEX_AUTH_SECRET_KEY)))
    .get();
  const raw = stored?.valueJson || env.OPENAI_CODEX_OAUTH_JSON || '';
  const parsed = raw ? normalizeCodexOAuthJson(raw) : null;
  return {
    configured: !!raw,
    source: stored ? 'ui' : raw ? 'worker-secret' : 'missing',
    valid: !!parsed,
    updatedAt: stored?.updatedAt ?? null,
    expiresAt: parsed?.expiresAt ?? null,
  };
}

function normalizeCodexOAuthJson(raw: string): { valueJson: string; expiresAt: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const source = isPlainObject(parsed) && isPlainObject(parsed['openai-codex']) ? parsed['openai-codex'] : parsed;
  if (!isPlainObject(source)) return null;
  const access = typeof source.access === 'string' ? source.access : '';
  const refresh = typeof source.refresh === 'string' ? source.refresh : '';
  const expires = typeof source.expires === 'number' ? source.expires : Number(source.expires);
  if (!access || !refresh || !Number.isFinite(expires)) return null;
  const auth: Record<string, unknown> = { type: 'oauth', access, refresh, expires };
  if (typeof source.accountId === 'string') auth.accountId = source.accountId;
  return { valueJson: JSON.stringify(auth), expiresAt: expires };
}

function agentCallbackBase(env: Env, requestUrl: string): string {
  const configured = env.AGENT_CALLBACK_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  const origin = new URL(requestUrl).origin;
  // ponytail: custom domain is Cloudflare Access-gated; workers.dev lets the existing bridge token reach app auth.
  return origin === 'https://board.thite.site' ? BOARD_WORKERS_DEV_ORIGIN : origin;
}

function resolvePiModel(env: Env, requested?: unknown, defaults: Partial<Record<PiModelProvider, string>> = {}): PiModelSelection {
  const picked = normalizePiModelSelection(requested);
  if (picked) return picked;
  const envPicked = normalizePiModelSelection(env.AGENT_LLM_MODEL_ID);
  if (envPicked) return envPicked;

  const providerId = normalizePiProvider(env.AGENT_LLM_PROVIDER) ?? (env.OPENAI_CODEX_OAUTH_JSON ? 'openai-codex' : 'amazon-bedrock');
  const envModel = typeof env.AGENT_LLM_MODEL_ID === 'string' && env.AGENT_LLM_MODEL_ID.trim() ? env.AGENT_LLM_MODEL_ID.trim() : undefined;
  if (providerId === 'openai-codex') return { providerId, modelId: envModel || defaults['openai-codex'] || DEFAULT_CODEX_AGENT_MODEL };
  return { providerId, modelId: envModel || defaults['amazon-bedrock'] || env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_AGENT_MODEL };
}

function normalizePiModelSelection(value: unknown): PiModelSelection | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  const mapped = PI_MODELS.get(raw) ?? PI_MODELS.get(`amazon-bedrock/${raw}`);
  if (mapped) return mapped;
  const slash = raw.indexOf('/');
  if (slash <= 0) return undefined;
  const providerId = normalizePiProvider(raw.slice(0, slash));
  const modelId = raw.slice(slash + 1).trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

function normalizePiProvider(value: unknown): PiModelProvider | undefined {
  return value === 'openai-codex' || value === 'amazon-bedrock' ? value : undefined;
}

function normalizePiThinkingLevel(value: unknown): AgentThinkingLevel | undefined {
  return typeof value === 'string' && PI_THINKING_LEVELS.has(value as AgentThinkingLevel) ? value as AgentThinkingLevel : undefined;
}

function isTurnRole(v: unknown): v is 'user' | 'assistant' | 'system' {
  return v === 'user' || v === 'assistant' || v === 'system';
}

function isTurnKind(v: unknown): v is 'message' | 'status' | 'error' | 'summary' {
  return v === 'message' || v === 'status' || v === 'error' || v === 'summary';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function safeJsonObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeJsonObjectOrNull(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  const parsed = safeJsonObject(json);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function piTextDelta(event: Record<string, unknown>): string {
  if (event.type !== 'message_update') return '';
  const ev = isPlainObject(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
  if (!ev || ev.type !== 'text_delta') return '';
  if (typeof ev.delta === 'string') return ev.delta;
  if (typeof ev.text === 'string') return ev.text;
  const delta = isPlainObject(ev.delta) ? ev.delta : null;
  if (typeof delta?.text === 'string') return delta.text;
  const contentDelta = isPlainObject(ev.contentDelta) ? ev.contentDelta : null;
  return typeof contentDelta?.text === 'string' ? contentDelta.text : '';
}

function piAssistantText(event: Record<string, unknown>): string {
  const message = isPlainObject(event.message) ? event.message : null;
  return message?.role === 'assistant' ? piMessageText(message) : '';
}

function piMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!isPlainObject(block)) return '';
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    return '';
  }).filter(Boolean).join('\n');
}

function piSessionPatch(value: unknown): Partial<typeof schema.agentSessions.$inferInsert> {
  if (!isPlainObject(value)) return {};
  const patch: Partial<typeof schema.agentSessions.$inferInsert> = {};
  if (typeof value.id === 'string' && value.id.trim()) patch.piSessionId = value.id.trim().slice(0, 120);
  if (typeof value.file === 'string' && value.file.trim()) patch.piSessionFile = value.file.trim().slice(0, 500);
  if (typeof value.cwd === 'string' && value.cwd.trim()) patch.piCwd = value.cwd.trim().slice(0, 500);
  return patch;
}

function normalizePiEntry(sessionId: string, entry: unknown, now: number): typeof schema.agentPiEntries.$inferInsert | null {
  if (!isPlainObject(entry)) return null;
  const piEntryId = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
  const piType = typeof entry.type === 'string' && entry.type.trim() ? entry.type.trim() : null;
  const piTimestamp = typeof entry.timestamp === 'string' && entry.timestamp.trim() ? entry.timestamp.trim() : null;
  if (!piEntryId || !piType || !piTimestamp) return null;
  const message = isPlainObject(entry.message) ? entry.message : null;
  return {
    sessionId,
    piEntryId,
    piParentId: typeof entry.parentId === 'string' && entry.parentId.trim() ? entry.parentId.trim() : null,
    piType,
    piTimestamp,
    role: message && typeof message.role === 'string' ? message.role : null,
    toolCallId: message && typeof message.toolCallId === 'string' ? message.toolCallId : null,
    rawJson: jsonForStorage(entry),
    createdAt: now,
  };
}

function toAgentTurn(row: typeof schema.agentTurns.$inferSelect) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    role: row.role,
    kind: row.kind,
    content: row.content,
    piEntryId: row.piEntryId ?? null,
    piParentEntryId: row.piParentEntryId ?? null,
    piMessageRole: row.piMessageRole ?? null,
    rawMessage: safeJsonObjectOrNull(row.rawMessageJson),
    createdAt: row.createdAt,
  };
}

function toAgentEvent(row: typeof schema.agentEvents.$inferSelect) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId ?? null,
    seq: row.seq,
    type: row.type,
    name: row.name ?? null,
    payload: safeJsonObject(row.payloadJson),
    piEntryId: row.piEntryId ?? null,
    piParentEntryId: row.piParentEntryId ?? null,
    toolCallId: row.toolCallId ?? null,
    rawEntry: safeJsonObjectOrNull(row.rawEntryJson),
    createdAt: row.createdAt,
  };
}

function toAgentPiEntry(row: typeof schema.agentPiEntries.$inferSelect) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    piEntryId: row.piEntryId,
    piParentId: row.piParentId ?? null,
    piType: row.piType,
    piTimestamp: row.piTimestamp,
    role: row.role ?? null,
    toolCallId: row.toolCallId ?? null,
    raw: safeJsonObject(row.rawJson),
    createdAt: row.createdAt,
  };
}

function toAgentArtifact(row: typeof schema.agentArtifacts.$inferSelect) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId ?? null,
    kind: row.kind,
    pathOrKey: row.pathOrKey ?? null,
    title: row.title ?? null,
    contentText: row.contentText ?? null,
    metadata: safeJsonObject(row.metadataJson),
    createdAt: row.createdAt,
  };
}

function toAgentSession(row: {
  id: string;
  provider: string;
  providerSessionId?: string | null;
  title?: string | null;
  status: string;
  ownerEmail: string;
  previewUrl?: string | null;
  cwd?: string | null;
  errorMessage?: string | null;
  piSessionId?: string | null;
  piSessionFile?: string | null;
  piCwd?: string | null;
  piLeafEntryId?: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}): AgentSession {
  return {
    id: row.id,
    provider: CLOUDFLARE_SANDBOX_PROVIDER,
    providerSessionId: row.providerSessionId ?? null,
    title: row.title ?? null,
    status: row.status as AgentSession['status'],
    ownerEmail: row.ownerEmail,
    previewUrl: row.previewUrl ?? null,
    cwd: row.cwd ?? null,
    errorMessage: row.errorMessage ?? null,
    piSessionId: row.piSessionId ?? null,
    piSessionFile: row.piSessionFile ?? null,
    piCwd: row.piCwd ?? null,
    piLeafEntryId: row.piLeafEntryId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

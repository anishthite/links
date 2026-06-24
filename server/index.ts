// Hono app shared between the Worker entrypoint and the legacy Pages Function.
// Keep all route mounts here, one line each.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { Env, Variables } from './env';
import { requireAccess } from './auth';
import { agentRoutes } from './routes/agent';
import { aiRoutes } from './routes/ai';
import { chatRoutes } from './routes/chat';
import { notesRoutes } from './routes/notes';
import { tagsRoutes } from './routes/tags';
import { wikiRoutes } from './routes/wiki';

export const app = new Hono<{ Bindings: Env; Variables: Variables }>().basePath('/api');

app.use('*', cors());

// Public — useful for uptime checks that can't carry an Access cookie (D-305).
app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

// Everything below requires a valid Cloudflare Access JWT in prod.
// Local dev (vars unset) ⇒ middleware no-ops with a warning.
app.use('/notes/*', requireAccess());
app.route('/notes', notesRoutes);
app.use('/links/*', requireAccess());
app.route('/links', notesRoutes);
app.use('/tags/*', requireAccess());
app.route('/tags', tagsRoutes);
app.use('/ai/*', requireAccess());
app.route('/ai', aiRoutes);
app.use('/chat/*', requireAccess());
app.route('/chat', chatRoutes);
app.use('/agent/*', requireAccess());
app.route('/agent', agentRoutes);
app.use('/wiki/*', requireAccess());
app.route('/wiki', wikiRoutes);

app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404));
app.onError((err, c) => {
  console.error('[api] uncaught', err);
  return c.json({ error: 'server error', detail: String(err) }, 500);
});

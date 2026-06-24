// Cloudflare Pages Function catchall — every /api/* request flows through Hono.
// Keep this file tiny on purpose; routes are defined in server/.

import { app } from '../../server';
import type { Env } from '../../server/env';

// Pages Function's EventContext has waitUntil/passThroughOnException, so it's
// runtime-compatible with Hono's expected ExecutionContext. The .props field
// added in newer @cloudflare/workers-types causes the type mismatch — cast.
export const onRequest: PagesFunction<Env> = (ctx) =>
  app.fetch(ctx.request, ctx.env, ctx as unknown as ExecutionContext);

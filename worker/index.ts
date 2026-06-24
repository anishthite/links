import { app } from '../server';
import type { Env } from '../server/env';
import { runAutoTagger } from '../server/lib/auto-tag';
import { maybeHandleDailyPageRequest, runDailyPageJob } from '../server/lib/daily-page';

export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx);
    const daily = await maybeHandleDailyPageRequest(request, env);
    if (daily) return daily;
    if (!env.ASSETS) return new Response('asset binding missing', { status: 500 });
    return env.ASSETS.fetch(request);
  },

  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil((async () => {
      await Promise.all([
        runAutoTagger(env)
          .then((result) => console.log('[auto-tag]', result))
          .catch((err) => console.error('[auto-tag] failed', err)),
        runDailyPageJob(env)
          .then((result) => { if (result.status === 'generated') console.log('[daily-page]', result.localDate); })
          .catch((err) => console.error('[daily-page] failed', err)),
      ]);
    })());
  },
};

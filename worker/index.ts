import { app } from '../server';
import type { Env } from '../server/env';
import { runAutoTagger } from '../server/lib/auto-tag';
import { maybeHandleDailyPageRequest, runDailyPageJob } from '../server/lib/daily-page';
import { runLinkScrapeBackfill } from '../server/lib/link-backfill';

export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx);
    const daily = await maybeHandleDailyPageRequest(request, env);
    if (daily) return daily;
    if (!env.ASSETS) return new Response('asset binding missing', { status: 500 });
    const appPath = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'GET' && (appPath === '/read' || appPath === '/random')) {
      const resurfaceUrl = new URL(request.url);
      resurfaceUrl.pathname = '/resurface';
      return Response.redirect(resurfaceUrl, 302);
    }
    if (request.method === 'GET' && appPath === '/resurface') {
      const indexUrl = new URL(request.url);
      indexUrl.pathname = '/';
      return env.ASSETS.fetch(new Request(indexUrl, request));
    }
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
        runLinkScrapeBackfill(env)
          .then((result) => { if (result.considered > 0) console.log('[link-backfill]', result); })
          .catch((err) => console.error('[link-backfill] failed', err)),
      ]);
    })());
  },
};

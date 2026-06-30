import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
}));

import worker from '../worker';

function envWithAssets() {
  const fetch = vi.fn(async (request: Request) => {
    return new Response(`asset:${new URL(request.url).pathname}`, {
      headers: { 'content-type': 'text/html' },
    });
  });
  return {
    ASSETS: { fetch },
  } as unknown as Parameters<typeof worker.fetch>[1] & { ASSETS: { fetch: typeof fetch } };
}

describe('worker SPA routes', () => {
  it.each(['/read', '/random'])('redirects %s to resurfacing', async (path) => {
    const env = envWithAssets();

    const res = await worker.fetch(new Request(`https://links.test${path}`), env, {} as ExecutionContext);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://links.test/resurface');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('serves /resurface from the SPA index asset', async () => {
    const env = envWithAssets();

    const res = await worker.fetch(new Request('https://links.test/resurface'), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset:/');
    const [assetRequest] = env.ASSETS.fetch.mock.calls[0] ?? [];
    expect(assetRequest).toBeInstanceOf(Request);
    expect(new URL((assetRequest as Request).url).pathname).toBe('/');
  });
});

// Cloudflare Access JWT verification middleware.
//
// Belt-and-suspenders auth: Cloudflare Access already gates the Pages origin
// (see implementation-notes/2026-05-28-cloudflare-access-auth.html D-300/D-301),
// but every /api/notes/* request is verified again here against Access's JWKS.
// If Access is ever bypassed or misconfigured, the API stays closed.
//
// No `jose`/`hono/jwt` dep — pure Web Crypto. Workers ships RSASSA-PKCS1-v1_5
// (RS256) and `crypto.subtle.importKey('jwk', …)` natively. ~80 lines beats a
// 50 KB dependency.
//
// Local dev: when `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is unset, the middleware
// no-ops with a console.warn — `wrangler pages dev` stays frictionless (D-304).

import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from './env';

type Jwk = { kid: string; kty: 'RSA'; n: string; e: string; alg?: string; use?: string };
type Jwks = { keys: Jwk[] };

// Module-scoped JWKS cache. Workers isolates are reused across many requests
// (see D-302), so a 5 min TTL keeps cold-start overhead to one fetch.
const JWKS_TTL_MS = 5 * 60_000;
const jwksCache = new Map<string, { fetchedAt: number; keys: Map<string, CryptoKey> }>();

async function getSigningKey(team: string, kid: string): Promise<CryptoKey | null> {
  const cached = jwksCache.get(team);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    const k = cached.keys.get(kid);
    if (k) return k;
    // Key not in cache — fall through to refetch (Access rotated mid-TTL).
  }
  const url = `https://${team}/cdn-cgi/access/certs`;
  const res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } as never });
  if (!res.ok) throw new Error(`Access JWKS fetch failed: ${res.status}`);
  const jwks = (await res.json()) as Jwks;
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks.keys) {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  jwksCache.set(team, { fetchedAt: Date.now(), keys });
  return keys.get(kid) ?? null;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  s += '='.repeat(pad);
  const bin = atob(s);
  // Explicit ArrayBuffer (not SharedArrayBuffer) keeps the TS5 + workers-types
  // BufferSource overload happy when this feeds crypto.subtle.verify.
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToString = (s: string) => new TextDecoder().decode(b64urlToBytes(s));

export type AccessClaims = {
  email?: string;
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  identity_nonce?: string;
};

export async function verifyAccessJwt(
  token: string,
  team: string,
  aud: string,
): Promise<AccessClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(b64urlToString(h)) as { alg: string; kid: string };
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);
  if (!header.kid) throw new Error('missing kid');
  const key = await getSigningKey(team, header.kid);
  if (!key) throw new Error(`no JWK for kid ${header.kid}`);
  const data = new TextEncoder().encode(`${h}.${p}`) as Uint8Array<ArrayBuffer>;
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    b64urlToBytes(s),
    data,
  );
  if (!ok) throw new Error('bad signature');
  const claims = JSON.parse(b64urlToString(p)) as AccessClaims;
  if (claims.iss !== `https://${team}`) throw new Error(`bad iss ${claims.iss}`);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new Error('bad aud');
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && now > claims.exp) throw new Error('expired');
  return claims;
}

/**
 * Hono middleware: require a valid Cloudflare Access JWT.
 *
 * - 401 if `Cf-Access-Jwt-Assertion` is missing or fails any check.
 * - Sets `c.get('userEmail')` to `claims.email` on success.
 * - No-ops (with a warning) when `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is unset
 *   so local `wrangler pages dev` and CI work without auth wiring (D-304).
 */
export const requireAccess = (): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> =>
  async (c, next) => {
    const aud = c.env.ACCESS_AUD;
    const team = c.env.ACCESS_TEAM_DOMAIN;
    if (!aud || !team) {
      console.warn('[auth] ACCESS_AUD / ACCESS_TEAM_DOMAIN unset — auth disabled (dev mode).');
      return next();
    }
    const bridgeToken = c.env.AGENT_BRIDGE_TOKEN;
    const bearer = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
    if (bridgeToken && bearer && bearer === bridgeToken) {
      c.set('userEmail', c.req.header('X-Board-Agent-Owner') || 'agent-bridge');
      return next();
    }

    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token) {
      return c.json({ error: 'unauthorized', detail: 'missing Cf-Access-Jwt-Assertion' }, 401);
    }
    try {
      const claims = await verifyAccessJwt(token, team, aud);
      c.set('userEmail', claims.email);
      return next();
    } catch (err) {
      console.warn('[auth] jwt verify failed', err);
      return c.json({ error: 'unauthorized', detail: String(err) }, 401);
    }
  };

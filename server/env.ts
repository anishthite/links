// Single source of truth for the Workers binding env.
// New bindings (AI, VECTORIZE, etc.) land here as we add them.

import type { Sandbox } from '@cloudflare/sandbox';

export type Env = {
  DB: D1Database;
  /** Worker static assets binding. Present in Worker deploys; absent in Pages-function tests. */
  ASSETS?: Fetcher;
  /** Cloudflare Sandbox Durable Object binding. Required for sandbox-backed agent sessions. */
  Sandbox?: DurableObjectNamespace<Sandbox<unknown>>;

  // Cloudflare Access — see implementation-notes/2026-05-28-cloudflare-access-auth.html.
  // Both are non-secret plain vars (D-306). Leave unset for local dev to bypass auth.
  /** Access Application AUD tag (hex). Required in prod. */
  ACCESS_AUD?: string;
  /** Access team domain, no scheme — e.g. `anishthite.cloudflareaccess.com`. Required in prod. */
  ACCESS_TEAM_DOMAIN?: string;

  // AWS Bedrock credentials for the AI arrange endpoint (Vercel AI SDK
  // + @ai-sdk/amazon-bedrock). Set via `wrangler pages secret put` in prod
  // and `.dev.vars` locally. Leaving any of these unset falls back to the
  // deterministic intent parser.
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  AWS_REGION?: string;
  /** Bedrock API key (short-lived bearer token, base64 "ABSK..."). When
   *  set, the AI SDK uses it via `Authorization: Bearer` and skips SigV4. */
  AWS_BEARER_TOKEN_BEDROCK?: string;
  /** Optional Bedrock model id override. Defaults to Claude Opus 4.6
   *  geo inference profile (`us.anthropic.claude-opus-4-6-v1`). */
  BEDROCK_MODEL_ID?: string;
  /** Sandbox pi provider. Set to `openai-codex` to use ChatGPT Plus/Pro Codex auth. */
  AGENT_LLM_PROVIDER?: string;
  /** Sandbox pi model id, optionally provider-qualified (`openai-codex/gpt-5.5`). */
  AGENT_LLM_MODEL_ID?: string;
  /** JSON for the `openai-codex` entry from pi `auth.json`; stored as a Worker secret. */
  OPENAI_CODEX_OAUTH_JSON?: string;
  /** Hourly note auto-tagger model. Defaults to Haiku 4.5. */
  TAGGER_MODEL_ID?: string;
  /** Expanded composer similar-notes model. Defaults to TAGGER_MODEL_ID, then Haiku 4.5. */
  SIMILAR_NOTES_MODEL_ID?: string;
  /** Max untagged notes the hourly auto-tagger mutates per run. Default 25, cap 100. */
  AUTO_TAG_LIMIT?: string;
  /** Max link sources the hourly scrape backfill refreshes per run. Default 5, cap 25. Set 0 to disable. */
  LINK_BACKFILL_LIMIT?: string;
  /** Optional local timezone for the daily page generator. Defaults to America/Los_Angeles. */
  DAILY_PAGE_TIMEZONE?: string;
  /** Optional external link scraper fallback. Supported: firecrawl, jina. */
  LINK_SCRAPER_PROVIDER?: string;
  /** API key for LINK_SCRAPER_PROVIDER when required or desired for higher limits. */
  LINK_SCRAPER_API_KEY?: string;
  /** Override endpoint for self-hosted Firecrawl/Jina-compatible deployments. */
  LINK_SCRAPER_ENDPOINT?: string;

  // Cloudflare Sandbox-backed agent config.
  /** Shared bearer token that lets the sandbox mirror pi JSONL entries back into Board. */
  AGENT_BRIDGE_TOKEN?: string;
  /** Optional origin for sandbox → Board callbacks when the browser origin is Cloudflare Access-gated. */
  AGENT_CALLBACK_BASE_URL?: string;
  /** Idle sandbox TTL in ms before opportunistic reaper tears it down. Default 15m. */
  AGENT_IDLE_TTL_MS?: string;
};

/** Hono `c.set` / `c.get` variables. */
export type Variables = {
  /** Email of the authenticated user, set by `requireAccess()` middleware. */
  userEmail?: string;
};

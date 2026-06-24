# `/Users/anishthite/workspace/board` — Survey

A dense, factual snapshot for someone planning to wire a cloud agent swarm into this codebase.

## Files Retrieved
1. `README.md` (full) — project framing, quick-start, deploy, Access auth setup.
2. `HANDOFF.md` (full) — operational manual; v0 acceptance status; gotchas.
3. `PLAN.md` (lines 1–100) — original v0 plan; tech-stack decision table.
4. `PLAN-whiteboard.md` (lines 75–205) — whiteboard v1 API + AI arrange contract.
5. `EXTENSIBILITY.md` (lines 1–225) — AI/agent extension roadmap on CF.
6. `COST_AND_ARCHITECTURE.md` (lines 1–80) — architecture diagram, free-tier math.
7. `context.md` (full) — recent cleanup recon (dead code, escape helpers, api.ts shapes).
8. `package.json` (full) — deps + ~30 scripts including db/migrate, tags pipeline, semantic build.
9. `wrangler.toml` (full) — Pages config, D1 binding, future-binding placeholders.
10. `db/schema.ts` (full) — Drizzle SQLite schema: `notes`, `tag_suggestions`, `ai_arrange_log`.
11. `db/migrations/{0001..0004}.sql` (full) — schema evolution.
12. `db/client.ts` (full) — `drizzle(d1, {schema})` wrapper.
13. `server/index.ts` (full) — Hono app, route mounts, `requireAccess` middleware wiring.
14. `server/env.ts` (full) — `Env` binding type (DB + ACCESS_* + AWS_* + BEDROCK_MODEL_ID).
15. `server/auth.ts` (full) — CF Access JWT verification via Web Crypto.
16. `server/routes/notes.ts` (full) — CRUD + position + suggestion routes.
17. `server/routes/tags.ts` (full) — POST /tags/rename, DELETE /tags/:tag.
18. `server/routes/ai.ts` (full) — `POST /api/ai/arrange[/stream]` deterministic + Bedrock.
19. `server/lib/semantic-layout.ts` (lines 1–50) — UMAP-coord layout strategy.
20. `functions/api/[[catchall]].ts` (full) — 8-line Pages-Function shim → Hono.
21. `src/lib/types.ts` (full) — wire vs in-memory Note types.
22. `src/lib/api.ts` (full) — client fetch wrappers incl. SSE `aiArrangeStream`.
23. `src/lib/tags.ts` (lines 1–60) — tag normalization rules.
24. `scripts/import-newnotes.ts` (lines 1–100) — Mongo→D1 importer.
25. `.dev.vars` (redacted) — Bedrock bearer-token creds for local dev.
26. `desktop/README.md` + `mobile/README.md` (heads) — Tauri 2 thin webview wrappers around `board.thite.site`.

## What `board` IS

A **single-user personal sticky-note board** (1,776 notes imported from a Mongo dump). Built as an extracted, self-contained app under `/board`; deployed to Cloudflare Pages at `board.thite.site` / `board.pages.dev`, gated by Cloudflare Access (Google SSO).

Three views over the same note corpus:
- **masonry** (locked visual at `themes/02e-bg.html`, `@chenglou/pretext`-driven absolute-positioned packing, scroll-virtualized).
- **list**.
- **whiteboard** — infinite 2D pan/zoom canvas with drag/multi-select/marquee, seeded by a deterministic grid, with an AI prompt bar that fires `POST /api/ai/arrange`.

Notes carry **first-class tags** (string array), inline `#hashtag`s are absorbed-and-stripped on write, and a `tag_suggestions` ghost-pill UI surfaces medium/low-confidence classifier proposals.

Native shells: thin **Tauri 2** webview wrappers in `desktop/` (macOS) and `mobile/` (iOS) pointing at the live URL — shipping the web app ships the apps.

## Tech Stack

| Layer | Choice |
|---|---|
| Bundler / dev | **Vite 6** (vanilla TS, no React) |
| Lang | **TypeScript 5.7**, strict |
| Layout engine | **`@chenglou/pretext` 0.0.7** (masonry text measurement); `umap-js` for semantic 2D |
| Styling | Tailwind 3 + small `board.css` (light-NERV palette) |
| API framework | **Hono 4** mounted via Pages Functions catchall (`functions/api/[[catchall]].ts`) |
| DB | **Cloudflare D1** (SQLite) via **Drizzle ORM 0.36** |
| Auth | **Cloudflare Access** JWT verified server-side in `server/auth.ts` (pure Web Crypto, no `jose` dep) |
| LLM | **AWS Bedrock** via **Vercel AI SDK** (`ai` 6 + `@ai-sdk/amazon-bedrock` 4) — Claude Sonnet 4.5 (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) by default |
| Embeddings (offline) | `@xenova/transformers` — used by `scripts/build-semantic-layout.ts`; not at request time |
| Schema validation | `zod` 4 (for Bedrock tool schemas) |
| ID | `short-uuid` (base58, 22 chars) |
| Native shells | **Tauri 2** (Rust) — desktop + iOS thin webview wrappers, no bundled JS |
| Test | Vitest + jsdom; `better-sqlite3` for offline scripts |

Dev scripts of note: `dev:cf` (wrangler pages dev), `preview:cf` (build + serve), `db:create`, multiple `db:migrate:{local,remote}` per migration, `db:import:{local,remote}`, `notes:apple:*` (export macOS Notes), `tags:backfill/strip/stitch/promote/eval/load/apply/audit` (the classifier pipeline), `semantic:build[:remote]` (UMAP coord JSON), `whiteboard:eval`, `tags:diagnose-misses`.

## Notes Storage — data model

### Source corpus: `newnotes.json`
- **909 KB, 1,776 records**, Mongo export shape: `{ _id:{$oid}, uuid, title, text, updated:{$date:{$numberLong}}, link? }`.
- Importer (`scripts/import-newnotes.ts`) **generates fresh short-uuid PKs** (does NOT reuse Mongo `uuid`), parses legacy inline hashtags into a real `tags[]` field, strips the first inline occurrence so the body stays clean, and emits `INSERT OR IGNORE` SQL keyed on a sha256 `content_hash` for idempotency.
- ~1,733 of 1,776 land; ~43 skipped (empty text).

### `notes` table (D1 SQLite, `db/migrations/0001_initial.sql` + `0003_tags_standalone.sql`)
```sql
notes(
  uuid           TEXT PRIMARY KEY,    -- short-uuid (base58, 22 chars)
  text           TEXT NOT NULL,       -- raw body, hashtags stripped on absorb
  tags           TEXT NOT NULL DEFAULT '[]',  -- JSON-encoded string[]
  color          TEXT,                -- nullable; null → derive from primary tag
  position_x     REAL,                -- whiteboard board-space px; nullable
  position_y     REAL,                -- nullable
  z_index        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,    -- epoch ms
  updated_at     INTEGER NOT NULL,    -- epoch ms; reverse-chrono sort key
  tags_updated_at INTEGER,            -- bumped separately from updated_at so
                                      -- tag-only edits don't reshuffle board
  content_hash   TEXT UNIQUE          -- sha256(normalized text) trunc 22 hex
)
CREATE INDEX idx_notes_updated_at_desc ON notes(updated_at DESC);
CREATE INDEX idx_notes_tags_updated_at ON notes(tags_updated_at);
```
Constraints: per-note `MAX_TAGS_PER_NOTE = 32`, `MAX_TEXT_LEN = 50_000`, coords clamped ±1e6.

### `tag_suggestions` (migration 0002)
```sql
tag_suggestions(
  uuid           TEXT PRIMARY KEY REFERENCES notes(uuid) ON DELETE CASCADE,
  suggested_tags TEXT NOT NULL,                  -- JSON string[]
  primary_tag    TEXT NOT NULL,                  -- ∈ suggested_tags
  confidence     TEXT NOT NULL,                  -- 'high' | 'medium' | 'low'
  rationale      TEXT,
  applied_at     INTEGER,                        -- null = pending
  created_at     INTEGER NOT NULL
)
```
High-conf rows are auto-applied to `notes.tags` by `scripts/auto-apply-high-conf.ts` and never surface. `GET /api/notes` LEFT JOINs only `applied_at IS NULL AND confidence != 'high'` and attaches them as `note.pendingSuggestion`.

### `ai_arrange_log` (migration 0004) — append-only telemetry
```sql
ai_arrange_log(
  id INTEGER PK AUTOINC, prompt TEXT, strategy TEXT,
  explanation TEXT, updates_count INTEGER, affected_uuids TEXT (JSON, cap 64),
  selected_uuids TEXT, status 'ok'|'empty'|'error',
  error_detail TEXT, duration_ms INTEGER, created_at INTEGER
)
```
Fire-and-forget logged from every `/api/ai/arrange[/stream]` call. Never read by the UI.

### Wire vs in-memory types (`src/lib/types.ts`)
```ts
type NoteWire = Omit<Note,'tags'> & { tags: string };   // tags is JSON string on wire
type Note = {
  uuid; text; tags: string[]; color: string|null;
  createdAt; updatedAt;
  pendingSuggestion?: { tags: string[]; primary: string; confidence: 'medium'|'low'; rationale: string };
  positionX?: number|null; positionY?: number|null; zIndex?: number;
}
```

## API surface (all under `/api`, all behind `requireAccess()` except `/api/health`)

Routes are defined in three files mounted by `server/index.ts`:

- `GET  /api/health` — public, `{ok, ts}`.
- `GET  /api/notes` — full list, reverse-chrono, joined with pending suggestions.
- `POST /api/notes` — `{text, tags?}` → 201 `{note}`; absorbs+strips inline `#hashtags`.
- `PATCH /api/notes/:uuid` — `{text?, tags?}`; updates `updated_at` / `tags_updated_at` per write-shape rules.
- `DELETE /api/notes/:uuid` — cascades `tag_suggestions` via FK.
- `PATCH /api/notes/:uuid/position` — `{x, y, z?}`, no timestamp bumps.
- `POST /api/notes/positions` — batch atomic via `d.batch([...])`, hard cap 500.
- `POST /api/notes/:uuid/accept-suggestion` — `{tags?}` (subset or all).
- `POST /api/notes/:uuid/reject-suggestion` — `{tags?}`.
- `POST /api/tags/rename` — `{from, to}` → `{renamed}`.
- `DELETE /api/tags/:tag` → `{removed}`.
- `POST /api/ai/arrange` — `{prompt, context?:{selectedUuids, viewportBoardRect}}` → `{updates:[{uuid,x,y}], explanation}`.
- `POST /api/ai/arrange/stream` — SSE; events: `status | tool-call | tool-result | done | error`.

## Existing agent / AI integration

`server/routes/ai.ts` is the entire current AI surface. It's an **AI-powered layout assistant**, not a chat or research agent.

**Strategy ladder (deterministic-first, fast-path):**
1. `semantic` — UMAP coords from `db/semantic-layout.json` (built offline by `scripts/build-semantic-layout.ts` using `@xenova/transformers`).
2. `cluster-by-tag` — sqrt-grid per primary tag.
3. `timeline` — sorted by `createdAt` along x.
4. `ring` — circle around origin.
5. `scatter` — FNV-1a hash-seeded pseudo-random within a box (deterministic on `uuid|prompt`).
6. `grid` — sqrt-grid by `createdAt`.
7. `tag-to-corner` — "move all #idea to top-left" verb+`#tag`+corner parser.

**Bedrock fallback** (when no deterministic regex matches AND `AWS_REGION` + (bearer OR sigv4) are configured):
- `generateText` (non-stream) or `streamText` (SSE).
- Single tool: `move_notes({explanation, updates:[{uuid,x,y}]})`, `toolChoice:'required'`.
- System prompt + compact corpus inventory (≤200 notes: `{uuid, title:first-line-≤80, tags, x, y}`).
- Model defaults to `us.anthropic.claude-sonnet-4-5-20250929-v1:0`; override via `BEDROCK_MODEL_ID`.
- **Server enforces safety regardless of source**: whitelists uuids against actual notes, clamps coords to ±1e6.
- **Streaming variant emits SSE toasts** for `text-delta` → "model is thinking…", `tool-call` (with note count preview), `tool-result` (with applied count).
- Errors swallowed → falls back to deterministic.

**Embeddings pipeline (offline only)**: `scripts/build-semantic-layout.ts` runs `@xenova/transformers` locally, dumps `db/semantic-layout.json` with 2D UMAP coords keyed by uuid. No Workers AI / Vectorize / R2 bindings live yet.

**Tag classifier pipeline (offline batch)**: a constellation of scripts/python files under `scripts/` (`stitch-suggestions.py`, `cluster-notes.py`, `auto-apply-high-conf.ts`, `eval-classifier.ts`, etc.) produce `db/tag-suggestions-final.jsonl`, which `scripts/load-suggestions.ts` ingests into the `tag_suggestions` table. None of this runs at request time.

## Auth & deploy target

- **Hosting**: Cloudflare Pages, project name `board`. `pages_build_output_dir = "dist"` (Vite output). One Pages Function (`functions/api/[[catchall]].ts`, 8 lines) forwards every `/api/*` to the Hono app.
- **D1**: production database `board-db` id `9caa972d-f4d1-4262-81d0-f991e65dbdfa` (WNAM). Local dev uses miniflare's SQLite.
- **`CLOUDFLARE_ACCOUNT_ID`**: `38136d7e8e51d4450fd5687cdba2ce2a` (anishthite@gmail.com). Do **not** put `account_id` in `wrangler.toml` — Pages-Git build rejects it.
- **Auth**: Cloudflare Access (Zero Trust) gates the Pages origin; `server/auth.ts` belt-and-suspenders verifies the `Cf-Access-Jwt-Assertion` JWT on every `/api/notes|tags|ai/*` request against the team JWKS. Both `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` are non-secret env vars. Missing locally → middleware no-ops with a warning.
- **Secrets**: `.dev.vars` carries `AWS_REGION` + `AWS_BEARER_TOKEN_BEDROCK` + `BEDROCK_MODEL_ID` for local Bedrock. Prod uses `wrangler pages secret put` (per comments in code). IAM SigV4 (`AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN`) supported as fallback but the active path is bearer-token.
- **Deploy command**: `npm run deploy` → `vite build && wrangler pages deploy dist --project-name=board`.

## Bindings declared / reserved (`wrangler.toml`)

Active:
- `DB` → D1.

Reserved as commented-out placeholders (for the agent extension):
- `AI` → Workers AI / AI Gateway.
- `VECTORIZE` → vector DB (`notes-embeddings` index name reserved).
- `ATTACHMENTS` → R2 bucket (`board-attachments`).

`EXTENSIBILITY.md` is the on-ramp doc: it lays out exactly which CF primitives map to which agent-platform need (Durable Objects per-agent, Workflows for long-running, Sandbox SDK for code exec, Vectorize for RAG over notes, Browser Rendering for research agents).

## Things relevant to wiring a cloud agent swarm

- **`Env` type (`server/env.ts`) is the single canonical place to declare new bindings.** Add `AI: Ai`, `VECTORIZE: VectorizeIndex`, `AGENT: DurableObjectNamespace`, etc. here, mirror them in `wrangler.toml`, and they're injected into every Hono handler via `c.env`.
- **Hono is already wired with CORS + middleware + per-route auth gating.** Adding `/api/agents/*` or `/api/swarm/*` is one `app.use + app.route` pair in `server/index.ts`.
- **SSE is already in use** (`POST /api/ai/arrange/stream`) — `hono/streaming`'s `streamSSE` is the template; the client's `aiArrangeStream` in `src/lib/api.ts` is a reusable POST-SSE reader pattern (it doesn't use `EventSource` because POST + JSON body is required).
- **Vercel AI SDK is already imported and working** with `tool({ inputSchema: z.object(...), execute })`, `toolChoice:'required'`, and `fullStream` iteration. Adding more tools to the model is purely additive. Pattern to copy: `tryArrangeWithBedrockStreaming` in `server/routes/ai.ts`.
- **AWS Bedrock bearer-token + region creds live in `.dev.vars` and Pages secrets.** Swap-in Anthropic-direct, Workers AI, or AI Gateway endpoints by changing the provider factory; the rest of the SDK code stays identical.
- **Append-only `ai_arrange_log` table is the existing model for telemetry.** Mirror this shape for any new agent-call logging (`prompt`, `strategy`, `status`, `duration_ms`, JSON arrays for affected uuids).
- **Whitelisting + clamping is the established safety pattern.** Every server route filters LLM-emitted uuids against the actual `notes` set and clamps coordinates; new agent tools should follow the same pattern.
- **Notes are 1,776 rows, ~2MB; the entire corpus is fetched in one shot** (`GET /api/notes`). At this scale, agents can be handed the full inventory in-prompt (the AI arrange route caps at 200 to bound Bedrock prompt size).
- **Tag system is the existing classification surface.** `tag_suggestions` table + accept/reject endpoints + ghost-pill UI provide a precedent for "agent proposes, user approves" UX.
- **Two timestamp columns (`updated_at`, `tags_updated_at`) and position columns (`position_x/y`, `z_index`) are independent** — agent writes can choose which axis to bump without reshuffling the board.
- **Auth is per-route, not per-app.** A `/api/agents/public-status` route can skip `requireAccess()`; everything else inherits the middleware.
- **Cost model (`COST_AND_ARCHITECTURE.md`)**: free tier covers everything except Workers Paid ($5/mo) is required to unlock Sandbox, Containers, Vectorize, Browser Rendering, Workflows.

## Architecture

```
Browser (Vite SPA: board.ts + whiteboard.ts + header.ts)
  │ fetch /api/...               SSE for /ai/arrange/stream
  ▼
Cloudflare Pages
  ├─ static dist/              (Vite build of src/)
  └─ functions/api/[[catchall]].ts  ── 8-line shim → server/index.ts
                                        │
                                        ▼
                                 Hono app (server/)
                                  ├─ /health (public)
                                  ├─ /notes/*  → routes/notes.ts  ⇒ Drizzle ⇒ D1
                                  ├─ /tags/*   → routes/tags.ts
                                  └─ /ai/*     → routes/ai.ts
                                                  ├─ deterministic ladder
                                                  ├─ semantic (db/semantic-layout.json, UMAP offline)
                                                  └─ Bedrock via Vercel AI SDK
                                                     (Claude Sonnet 4.5, move_notes tool)
                                  guarded by requireAccess() ↑
                                    (CF Access JWT via Web Crypto)
```

Tauri shells (desktop/mobile) are zero-JS WKWebView/WebKit pointers at the live URL — they don't affect the data flow.

## Start Here

Open **`server/routes/ai.ts`** first. It's the existing template for an agent-shaped endpoint: deterministic-first fallback, Bedrock-via-AI-SDK tool-call, SSE streaming with status events, telemetry table writes, server-side safety filtering. Any new agent route (research, RAG-over-notes, scheduled summaries, sandbox exec) should fork that file's shape. Then read `server/env.ts` + `wrangler.toml` to learn the binding plumbing, and `EXTENSIBILITY.md` for the CF-primitive cheat sheet.

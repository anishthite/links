# Genasite Survey

Repo root: `/Users/anishthite/workspace/shitty-artifacts/genasite`

Branded as **Playscape / sitebrew** in code and prompts. README at the root is literally `push` (one word) — there is no real top-level readme. Docs are scattered as `*_SUMMARY.md` / `*_IMPLEMENTATION.md` files in the root.

---

## 1. What this project IS

A web product that takes a natural-language prompt from a user, runs an **AI coding agent** server-side to generate a single-page (or multi-file) browser game / interactive site, persists the files to Cloudflare R2, and serves them under `https://games.playscape.gg/<threadId>/v<N>/index.html` from an iframe in the Next.js frontend.

Branding lives on `playscape.gg` (and historically `sitebrew.ai`). Frontend at `playscape.gg / sitebrew.ai`, API at `back.playscape.gg / back.sitebrew.ai`, compile service at `compile.playscape.gg / compile.sitebrew.ai`, game CDN at `games.playscape.gg`.

Components in the repo:

| Path | Role | Stack | Notes |
|---|---|---|---|
| `frontend/` | UI, auth, project mgmt, polling | Next.js + TS + Tailwind + Supabase + Prisma | Deployed on Vercel (`vercel.json`, `.vercel`). Calls backend via `NEXT_PUBLIC_API_URL`. |
| `backend-bun/` | **Live agent server (opencode fork)** | Bun + Hono + Prisma + AWS SDK | Containerized; this is the one that actually runs the agent. |
| `backend/` | Legacy FastAPI orchestrator (Python) | FastAPI + Anthropic/OpenAI/Replicate | Pre-opencode pipeline (PRD → designer → image gen → final code → compile). Still has a Dockerfile; superseded by `backend-bun`. |
| `builder/` | "Compile" microservice | Node 18 + Express + esbuild + JSDOM | `POST /compile` takes `{"/App.jsx", "/index.jsx"}` or raw HTML, wraps in template, bundles imports from `cdn.jsdelivr.net`, returns final HTML. Port 3003. |
| `cli/` | `playscape` CLI + the **canonical opencode fork** under `cli/packages/opencode/` | Bun + SST | Same source as `backend-bun/src/agent/*` — see §2. Has `sst.config.ts`, `turbo.json`, distributed via `install-playscape.{sh,ps1,bat}`. |
| `sdk/` | `@playscape/sdk` runtime injected into games | Bun build | Mobile controls, viewport scaling, IAP/leaderboard client. |
| `workers/` | Cloudflare Workers | wrangler | `image-router` (`covers.playscape.gg/*`), `make-game-chron`, `make-screenshot-cron`, `make-title-chron`, `generation-processor`. |
| `html-games/` | Cloudflare Worker that serves js13k-style games out of R2 | wrangler | Bindings: `PLAY`, `ASSETS`, `RUNTIME`. |
| `bot/` | Discord bot (slash commands → generation) | TS + discord.js | Has its own Dockerfile, shares DB. |
| `discord/featureBot/` | Another discord bot | — | Separate. |
| `desktop/` | Electron wrapper | — | Opens generated games as desktop app. |
| `experiments/`, `ig_script/`, `tests/`, `git_updates/` | Scratch | — | Not on the hot path. |
| `Dockerfile` (root) | Stale/broken | Node 18 | `WORKDIR ./builder` + `WORKDIR ./src` is malformed; appears to target the builder service. Not the real entrypoint. |

There is **no `docker-compose.yml`, no systemd unit, no Terraform, no Kubernetes manifest** anywhere in the repo. Deployment is implicit: build each Dockerfile, run on the droplet, point DNS.

---

## 2. The opencode fork

`backend-bun/src/agent/` and `cli/packages/opencode/src/` are **the same opencode codebase** vendored twice. `diff -q` confirms all subdirs (`session/`, `tool/`, `provider/`, `lsp/`, `mcp/`, `snapshot/`, `permission/`, `bus/`, `share/`, `agent/`, `cli/`, etc.) are common. The only structural difference: backend-bun adds `skill/` and drops `plugin/`; CLI keeps the standalone entrypoint.

Identity markers proving the fork:

- `backend-bun/src/agent/global/index.ts:5` — `const app = "opencode"` → all XDG dirs live under `~/.local/share/opencode`, `~/.cache/opencode`, `~/.config/opencode`, `~/.local/state/opencode`.
- `backend-bun/src/agent/session/prompt/anthropic.txt` is the verbatim opencode/Claude-Code-style system prompt ("You are an interactive CLI tool that helps users with software engineering tasks…").
- `backend-bun/src/agent/session/system.ts:12` loads `PROMPT_ANTHROPIC_SPOOF` — opencode's anthropic-impersonation header.
- Tools mirror opencode's set: `read`, `write`, `edit`, `multiedit`, `bash`, `glob`, `grep`, `ls`, `patch`, `webfetch`, `task`, `todo`, `lsp-diagnostics`, `lsp-hover` — plus Playscape-specific additions: `generate-image`, `generate-3d-model`, `generate-music`, `generate-sfx`, `generate-speech`, `copy-asset`, `create-in-app-product`.
- LSP, snapshot (per-project `git` shadow), permission, share, bus, MCP — all 1:1 opencode.

Genasite-specific deltas on top of opencode:

1. The whole `playscape-services/` subtree (`compiler/html5-compiler`, `compiler/raylib-compiler`, `controller`, `queue`, `uploader`, `worker-pool`, `progress`) — for building HTML5 / Raylib output and uploading to R2.
2. `project/workspace.ts` (R2-backed versioned workspaces, see §5).
3. `storage/r2.ts`, `storage/config.ts`, `storage/cleanup.ts` (R2 lifecycle).
4. `asset-agent/` (multimodal asset generation tools).
5. The Hono HTTP server at `backend-bun/src/server.ts` that exposes opencode's session machinery as `/generate` (vs. opencode's normal stdio/TUI entrypoint).
6. `skill/` directory and `playscape.json` IAP/style manifest convention.

### How the agent is invoked (server hot path)

Frontend `frontend/app/api/ai/startBackendGeneration/route.ts:77-95` → `POST {NEXT_PUBLIC_API_URL}/generate` with `{ prompt, history, projectId, fileNames, threadId, user, sessionToken }`.

Backend `backend-bun/src/server.ts`:

- Line ~450: `POST /generate` (SSE if `?stream=1` or `Accept: text/event-stream`, else returns `{generationId, status}` and runs in background).
- Both paths wrap the work in:
  ```ts
  Instance.provide({ directory: process.cwd(), init: InstanceBootstrap, fn: async () => {
    const session = await Session.create({})
    const result = await SessionPrompt.prompt({
      sessionID: session.id,
      threadId: payload.threadId || payload.projectId,
      parts: [{type:"text", text: payload.prompt}, ...fileParts],
    }, { onEvent: async (evt) => { /* stream as SSE */ } })
  } })
  ```
- `SessionPrompt.prompt` (`backend-bun/src/agent/session/prompt.ts`):
  - `storageId = input.threadId || input.sessionID` (line 211).
  - `Workspace.loadFromR2(storageId)` — downloads the previous version's files into `/tmp/games/<threadId>/v<N>/` (line 217).
  - Computes a checksum (`calculateWorkspaceChecksum`) before.
  - Re-enters `Instance.provide({ directory: workspacePath, sessionId, ... })` so all tool calls operate inside that workspace.
  - Runs the LLM loop with tools (anthropic via AWS Bedrock by default per `.env`: `BEDROCK_MODEL_ID=us.anthropic.claude-opus-4-6-v1`).
  - After the loop, computes checksum again; if changed, `Workspace.getNextVersion()` + `Workspace.syncWorkspaceToR2Version()` uploads `/tmp/games/<threadId>/v<N>/**` to R2 under `<threadId>/v<N>/`, updates `threads.published_id` and creates a `game_versions` row.
  - Optionally syncs IAP products from `playscape.json` into `iap_products` table.
  - Emits `workspace-synced` event with `{version, url, threadId, hasChanges}`.

Bus events (`tool-call`, `tool-result`, `text-delta`, `step-finish`, `workspace-synced`, `session.error`, etc.) are recorded via `recordEvent()`, batched into `generation_event` rows (batch 10 / 100 ms — server.ts ~190), AND mirrored to in-memory `generationEventLogById` for SSE replay. The frontend polls `/generation/:id/events?since=N` or subscribes to Supabase Realtime on `generation_status` / `generation_event`.

### Deploy story for backend-bun

`backend-bun/Dockerfile` (only deploy artifact for the agent):
- `FROM oven/bun:1.3`
- `apt-get install git ca-certificates ripgrep` (git is required by `snapshot/index.ts` which does `git init` per project under `~/.local/share/opencode/snapshot/<projectId>` to track tool-edit deltas; ripgrep for `grep`/`ls` tools).
- `bun install --frozen-lockfile`, `bun run prisma:generate`, copy `src/`.
- Runs as non-root user `appuser`; sets `HOME=/home/appuser`. **Pre-creates `/tmp/games`** and chowns it.
- `CMD ["bun", "run", "src/server.ts"]`, exposes 8000.
- No healthcheck enabled.

`backend-bun/build.sh` is a 4-line `docker build`. `backend-bun/run.sh` is `docker run --rm -p 8000:8000 --env-file .env`. **That is the entire deploy.** On the DigitalOcean droplet there's presumably a single long-running container per the run.sh pattern; reverse proxy (Caddy/nginx) and TLS termination are *not* in the repo, so they must live as droplet-level config.

CORS origins hard-coded in `backend-bun/src/server.ts:129-145` and `backend/main.py:30-44`: `sitebrew.ai`, `playscape.gg`, `back.*`, `compile.*`, plus localhost. Confirms single shared backend host.

---

## 3. Tech stack (canonical, live path)

- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind, Supabase (auth + Postgres + Realtime), Prisma, Vercel.
- **Agent backend:** Bun 1.3, Hono, opencode (vendored), Prisma + Supabase Postgres (via pgbouncer pooler), Cloudflare R2 (`@aws-sdk/client-s3`), Sentry, Anthropic via AWS Bedrock (primary) + fal.ai + ElevenLabs + Replicate.
- **Compile builder:** Node 18, Express, esbuild, JSDOM (port 3003, `https://compile.playscape.gg`).
- **Workers:** Cloudflare Workers (wrangler) for image router, screenshot/title crons, game asset serving.
- **Game runtime:** R2 + Cloudflare Worker (`html-games/`) serving static files; `@playscape/sdk` injected client-side.
- **Bots:** Discord bot in `bot/` (Node, slash commands → backend `/generate`).
- **Desktop:** Electron wrapper in `desktop/`.
- **Legacy:** Python FastAPI in `backend/` (still has Sentry init, still references `opencode` via `services/opencode_client.py` talking to a separate opencode HTTP server at `OPENCODE_BASE_URL=http://localhost:8081` — pre-fork era).

---

## 4. How games are generated / stored / served

1. **Generate:** Frontend → Next.js API route → `POST /generate` on the bun backend (SSE).
2. **Workspace load:** `Workspace.loadFromR2(threadId)` pulls latest non-reverted version from R2 into `/tmp/games/<threadId>/v<N>/` (`backend-bun/src/agent/project/workspace.ts:130-180`). If first generation, just `mkdir -p`.
3. **Agent loop:** opencode session runs with tools rooted at that workspace dir (`Instance.provide({directory: workspacePath})`). Tool calls (`write`, `edit`, `bash`, `generate_image`, `generate_3d_model`, `generate_speech`, `copy_asset`, `multiedit`, `patch`, `lsp-*`, etc.) read/write inside that dir. `snapshot/` namespace shadow-commits each step into `~/.local/share/opencode/snapshot/<projectId>/.git` for revert support.
4. **Sync:** Checksum compare (SHA-256 over sorted file path+content). On change: `getNextVersion()` (queries `game_versions` table, falls back to R2 listing), then `syncWorkspaceToR2Version()` uploads every file to `<threadId>/v<N>/*` in R2 bucket `games`.
5. **Publish:** Updates `threads.published_id = "<N>"`, inserts `game_versions` row with `r2_path = "<threadId>/v<N>/"`.
6. **Persist conversation:** `telemetry.ts` writes `HTMLSite`, `conversations`, `threads`, `generation_event[]`, `generation_status` rows.
7. **Serve:** Frontend iframe `src` points at `https://games.playscape.gg/<threadId>/v<N>/index.html`. That domain is served by the Cloudflare Worker in `html-games/` from the R2 bucket (per `R2_PUBLIC_URL=https://games.playscape.gg` in `backend-bun/.env`).
8. **Compile path (legacy/React games):** If a generated artifact is React JSX, the older flow posts `{/App.jsx, /index.jsx}` to `https://compile.sitebrew.ai/compile` (the `builder/` service), which esbuild-bundles with jsdelivr CDN, returns HTML. Used by the FastAPI backend (`backend/services/orchestration.py:compile_code`). The bun backend extracts `<ant_artifact>` content and skips compilation for HTML games.
9. **Screenshots/titles:** `make-screenshot-cron`, `make-title-chron` workers run on a schedule against new threads to produce thumbnails / titles.

---

## 5. What state persists between requests (the stateful surface)

This is the critical area for the droplet → per-session VM question.

### A. Persistent across all requests (must survive everywhere)
- **Supabase Postgres** (managed; `aws-0-us-west-1.pooler.supabase.com`): tables include `users`, `HTMLSite`, `conversations`, `threads`, `generation_status`, `generation_event`, `game_versions`, `htmlsite_r2_lookup`, `iap_products`, `iap_purchases`, `user_credits`, `credit_transactions`, `developer_earnings`, `subscriptions`, `tags`, `site_tags`, `page_view`, `page_like`, `thread_like`, `leaderboard_cache`, `cli_device_codes`, `CliSession`, `WasmUpload`, `generated_images`, `email_templates`, `creator_stripe_accounts`, `products`, `prices`. 28 models total.
- **Cloudflare R2** (managed; bucket `games` at `games.playscape.gg`, also `uploads` bucket and `screenshots` bucket): the canonical store for all generated game files, asset uploads, and screenshots. Versioned per-thread: `<threadId>/v<N>/*`.
- **Supabase Realtime:** front-end subscribes to `generation_status` row updates → server only has to write the DB row.

### B. State that lives on the droplet's local filesystem (the part that breaks under per-session VMs)

1. **`/tmp/games/<threadId>/v<N>/` — the agent workspace.** Created by `Workspace.getWorkspace()` / `loadFromR2()`. Every tool call (`write`, `edit`, `bash`, `multiedit`, etc.) reads/writes here. *Already* loaded from R2 at start and synced back at end, so per-request it's effectively a cache. **However**:
   - Cleanup job (`storage/cleanup.ts`) runs every 15 min and deletes workspaces idle >1 h.
   - The `workspaces` Map keeps in-memory metadata (`workspaceKey` → `{threadId, version, path, lastAccess, fileCount}`).
   - `/tmp/games/<threadId>/uploads/` (per `agent/file/resolver.ts:23`) — user file attachments downloaded from `https://playscape.gg/f/` for the agent to see. Cleaned alongside stale workspaces.

2. **`~/.local/share/opencode/storage/` (XDG_DATA / `Global.Path.data`)** — opencode's JSON session store. `storage.ts:122` writes `{dir}/session/<projectId>/<sessionId>.json`, `message/<sessionId>/<messageID>.json`, `part/<messageID>/<partID>.json`, `share/<id>.json`. Migrations file at `{dir}/migration`. **This is what makes opencode resume a conversation** — without it you lose multi-turn context.

3. **`~/.local/share/opencode/snapshot/<projectId>/`** — a hidden `git` repo per project that `snapshot/index.ts:33` initializes (`git init`) and writes tree hashes into after each tool step. Used for `SessionRevert` (rolling tool edits back). Tied to `Project.fromDirectory(directory)` — i.e. tied to the workspace directory path.

4. **`~/.cache/opencode/`** — model cache, version pin.

5. **In-process state** (lost on droplet restart, but stable while the bun process runs):
   - `generationStatusById: Map<string, GenerationStatus>` (`server.ts:147`).
   - `generationEventLogById: Map<string, any[]>` ring buffer of 2000 events for SSE replay.
   - `generationChannels: Map<string, Set<Writer>>` — open SSE subscribers.
   - `eventBatches`, `eventBatchTimers` for batched DB writes (100ms flush).
   - `Instance.cache: Map<string, InstanceContext>` (`project/instance.ts:11`) — keyed by `directory:sessionId`, holds resolved Project + worktree.
   - `SessionPrompt.state().queued` — pending child-session prompts.
   - `Bus` subscribers, `LSP` server processes (`agents/lsp/server.ts:790` is a fully embedded LSP server), `FileWatcher`, `Format` workers, `Share` clients — all initialized in `InstanceBootstrap` once per `Instance.directory`.

6. **Process-level dependencies the agent shells out to:**
   - `git` (snapshot system, hard requirement, in Dockerfile).
   - `ripgrep` (grep/list tools, in Dockerfile).
   - LSP servers (TS, etc., spawned per language under `agents/lsp/`).
   - `bash` tool runs arbitrary shell commands (`agent/tool/bash.ts`).

### C. What's truly stateless across requests (today)

- The HTTP request itself.
- `Provider`/`Auth` — pulls API keys from env + Supabase auth flow.
- All AI provider calls (Bedrock / fal / ElevenLabs).
- The compile microservice (`builder/`) — pure function of the input payload.
- The Cloudflare Workers.

---

## What the droplet currently does

One bun process (or a small replica set) on a DigitalOcean droplet, holding:

1. The Hono `/generate` SSE endpoint pool (`backend-bun`).
2. A warm cache of `/tmp/games/<threadId>/v<N>/` workspaces across recent users.
3. A warm cache of `~/.local/share/opencode/storage/` session JSON across recent sessions.
4. The per-project shadow git repos under `~/.local/share/opencode/snapshot/`.
5. `git`, `ripgrep`, LSP servers, the bash tool, file watcher, Sentry, Prisma client (pgbouncer connection).
6. In-memory SSE channels & event ring buffers.

Almost everything *important* round-trips to R2 + Supabase, but the local FS is the working surface for opencode's tool calls and resume-from-prior-turn behavior. The cleanup job exists precisely because the disk would otherwise fill up.

---

## What would need to change to run on per-session cloud VMs (OpenComputer-style hibernate/wake sandboxes)

The good news is the **R2-as-source-of-truth design is already there**. Workspaces are pulled from R2 on entry, pushed to R2 on exit, with a checksum gate. Per-session VMs is mostly about treating the local FS as ephemeral and being careful about what *isn't* round-tripped.

### Concrete changes / risks

1. **Workspace lifecycle is already R2-round-tripped — leverage it as the only state link.**
   - `Workspace.loadFromR2(threadId)` → load on wake.
   - `Workspace.syncWorkspaceToR2Version()` → sync on hibernate/exit.
   - Today: cleanup is reactive (15 min/1 h thresholds). On per-session VMs, sync should happen *every* turn end and the VM can be discarded — `hasChanges` checksum logic at `prompt.ts:587-606` already supports this.
   - Risk: long-running tool steps (`bash`, multi-step `edit`) that don't reach the post-loop sync block will lose work if the VM hibernates mid-step. Need a periodic intra-turn sync hook or rely on the snapshot system (see #3).

2. **opencode session storage (`~/.local/share/opencode/storage/`) is the hidden stateful piece.**
   - `Session.create()` writes `session/<projectId>/<sessionId>.json`. `MessageV2` parts go to `message/<sessionId>/...json` and `part/<messageID>/<partID>.json`.
   - If you delete the VM and a follow-up turn lands on a fresh one with a new `threadId` request, opencode will create a *new* session, losing the conversation history.
   - **Options:**
     - (a) Persist this dir to R2 alongside the workspace (treat it as part of the artifact: `<threadId>/v<N>/.opencode-session/`). Cleanest fit with existing pattern.
     - (b) Replace the `Storage` namespace (`backend-bun/src/agent/storage/storage.ts`) with a Supabase / R2-backed implementation — it's already a thin key/value abstraction (`read/write/update/remove/list` on string-array keys). Less invasive than it looks, ~40 lines of code in the existing fs implementation. Sessions and messages are *already* normalized into per-id JSON files.
     - (c) Reconstruct session history from the `conversations` + `generation_event` tables on wake and bypass opencode's storage. Means rewriting `Session.create()` to hydrate; risky.
   - Without (a/b/c), follow-up edits on the same project are *broken* on a fresh VM.

3. **Snapshot git repo (`~/.local/share/opencode/snapshot/<projectId>/`)** powers `SessionRevert`. If you're OK losing revert capability across VM lifetimes, do nothing. Otherwise persist this dir to R2 too. It's a `git --git-dir` directory only, ~tens of KB usually.

4. **`Instance.cache` and per-Instance bootstrap (`Share.init`, `Format.init`, `LSP.init`, `Snapshot.init`, `FileWatcher.init`, `File.init`) run lazily once per `directory`.** On a per-VM model each VM is cold-started, so first-turn latency increases. The `PLAYSCAPE_EXPERIMENTAL_NO_BOOTSTRAP` flag at `bootstrap.ts:6` already exists — you can skip LSP/watchers for ephemeral VMs to cut cold start (at the cost of LSP diagnostics inside the agent loop).

5. **SSE / event delivery has to leave the VM.**
   - Today `generationEventLogById` (ring buffer) + open SSE writers live in-process. If the VM holding the agent isn't the same VM the user's HTTP connection lands on (router/load-balancer in front), SSE breaks.
   - There is already a Supabase-Realtime path: events are written to `generation_event` rows and `generation_status` is updated; the frontend can subscribe to Realtime directly (see `persistGenerationStatus` at `server.ts:163` and the "Supabase Realtime automatically pushes this update" comment).
   - Path forward: make Realtime the canonical event channel, drop the in-process SSE/ring-buffer fallback (or only keep it for the VM that actually owns the generation). Simpler than building a cross-VM pubsub.

6. **Architecture shape that fits:**
   - Stateless "router" service (Vercel function or a tiny always-on box) receives `POST /generate`, mints a sandbox VM (or wakes a hibernated one keyed by `threadId` for sticky resume), forwards the request, returns the `generationId`.
   - Sandbox VM does the full opencode loop, writes events to Supabase, syncs workspace to R2 on exit, hibernates or terminates.
   - Wake key options: `threadId` (sticky per game, gives you free session+snapshot continuity if you ship VM-local storage) OR fresh VM every turn (requires changes in #2/#3 above).
   - Need to scope per-VM resources: tools include unrestricted `bash`, `webfetch`, `write` — current permission model lives in `agent/permission/`, mostly an ACL on tool names, fine to keep.

7. **Things you can leave alone:**
   - Compile microservice (`builder/`) — already stateless.
   - Cloudflare Workers — already stateless.
   - Frontend / Supabase / R2 — managed.
   - Bots and CLI — they hit `/generate` over the network; routing change only.

8. **Things that quietly assume "the host":**
   - `Instance.directory = process.cwd()` is passed in by `server.ts` and treated as the project root. Inside opencode this becomes the `Project.id` (filesystem hash). On per-VM mode where `process.cwd()` is `/app` everywhere, all VMs share the same project id, which collides snapshot + session paths *across threads* if you also bind-mount or persist `Global.Path.data`. Make sure the persisted storage key includes `threadId`, not just `projectId`.
   - `cleanupStale()` 1-hour threshold is irrelevant on ephemeral VMs (lifetime < 1h anyway).
   - `Dockerfile` runs as `appuser` with `HOME=/home/appuser`. The XDG paths resolve under `/home/appuser/.local/share/opencode/...` — easy to bind-mount to persistent storage if you go that route.

9. **What to verify before flipping the switch:**
   - Run a fresh container, do turn 1 of a generation, kill the container, start a fresh one, do turn 2 with the same `threadId`. Today: turn 2 starts a brand-new opencode session and the agent has no memory of turn 1. Fix this first, regardless of VM strategy.
   - The Bus / SSE replay flow — confirm Supabase-Realtime path on its own gives the frontend everything it needs without `/generation/:id/stream`.

### Bottom line

The hard part of the work is already done: R2-versioned workspaces with checksum-gated sync. The remaining stateful pieces are opencode's own session/snapshot JSON+git dirs under `~/.local/share/opencode/` and a few in-process maps. Either (a) persist those two dirs to R2 keyed by `threadId`, or (b) swap `Storage` for a DB/R2-backed implementation (the abstraction is right-sized for that). After that, per-session hibernate/wake is mostly a routing exercise.

---

## Files another agent should open first

1. `backend-bun/src/server.ts` — entrypoint, request lifecycle, SSE, event pipeline, DB writes.
2. `backend-bun/src/agent/session/prompt.ts` — the agent loop with R2 load/sync bracketing.
3. `backend-bun/src/agent/project/workspace.ts` — R2 ↔ `/tmp/games` workspace manager and versioning.
4. `backend-bun/src/agent/storage/storage.ts` — opencode's JSON KV store (the second hidden stateful surface).
5. `backend-bun/src/agent/snapshot/index.ts` — per-project git shadow used for revert.
6. `backend-bun/src/agent/project/instance.ts` + `bootstrap.ts` — what's initialized once per directory, with `PLAYSCAPE_EXPERIMENTAL_NO_BOOTSTRAP` escape hatch.
7. `backend-bun/Dockerfile`, `backend-bun/run.sh` — current deploy surface.
8. `R2_COMPLETE_IMPLEMENTATION.md` — design doc for the R2/versioning model.
9. `backend-bun/prisma/schema.prisma` — DB shape (`threads`, `game_versions`, `generation_status`, `generation_event`).
10. `cli/packages/opencode/src/` — for cross-referencing what's stock opencode vs. Playscape additions.

# Links

Board, but for links.

Live app: <https://links.anishthite.workers.dev>

This is the same basic stack and surface area as `~/workspace/board`:
- Cloudflare Worker + Assets
- D1
- Hono
- the same masonry / list / agent UI
- the same sandbox-backed agent flow
- the same whiteboard, tag, chat, wiki, and daily-page surfaces

The main addition is **link-backed notes**:
- paste a URL in the add panel
- the Worker saves immediately, then fetches and extracts metadata/text in the background
- the note stores `source_*` metadata in D1
- longer extracts are stored as `note_source_chunks`
- search, chat, and similar-note retrieval use the saved extract too
- note cards and the editor expose the original source link

## Quick start

```sh
npm install
npm run db:migrate:all:local
npm run dev
```

Open <http://127.0.0.1:8788>.

`npm run dev` and `npm run dev:cf` talk to Wrangler's local D1 state in <code>.wrangler/state/v3/d1</code>, so you'll see your real local notes/links DB there. `npm run dev:vite` is frontend-only and will fall back to sample data when `/api/*` is missing.

If Docker is not running and you only want the app/API without local containers:

```sh
npx wrangler dev --enable-containers=false --port=8788 --ip=127.0.0.1
```

## First-time D1 setup

```sh
npm run db:create
# paste the printed database_id into wrangler.toml

npm run db:migrate:all:local
npm run db:migrate:all:remote
```

## Deploy

```sh
npm run typecheck
npm test
npm run build
npm run deploy
```

## Link note shape

`notes` now also carries:
- `source_url`
- `source_url_normalized`
- `source_title`
- `source_description`
- `source_site_name`
- `source_author`
- `source_published_at`
- `source_fetched_at`
- `source_content_text`
- `source_content_markdown`
- `source_status`
- `source_last_error`
- `source_final_url`
- `source_extractor`
- `source_status_code`
- `source_content_length`
- `source_content_truncated`

Longer source text is stored in `note_source_chunks` with one row per chunk.

Optional external scraper fallback:

```sh
LINK_SCRAPER_PROVIDER=firecrawl # or jina
LINK_SCRAPER_API_KEY=...
LINK_SCRAPER_ENDPOINT=...       # optional self-hosted/override endpoint
LINK_BACKFILL_LIMIT=5           # hourly missing-link scrape backfill; 0 disables
```

Without those vars, extraction stays local: YouTube transcript special case, Readability, then HTML body stripping.

Manual scrape backfill:

```sh
curl -X POST https://links.anishthite.workers.dev/api/notes/backfill-link-sources \
  -H 'content-type: application/json' \
  -d '{"limit":5}'
```

## Important routes

- `GET/POST /api/notes`
- `POST /api/notes/:uuid/refresh-link`
- `GET/POST /api/links` alias to the same note routes
- `POST /api/chat/stream`
- `POST /api/agent/sessions`
- `GET/POST /api/wiki/*`

## Local link tagging

```sh
npm run tags:links:local      # process one batch against local D1
npm run tags:links:local:all  # sweep until no unprocessed local link notes remain
```

Both commands open Wrangler's local sqlite file directly, so they mutate the same local DB that `npm run dev` reads.

## Notes

- Production currently runs on the default `workers.dev` hostname.
- Cloudflare Access is still optional; if the env vars are unset, auth no-ops.
- The deployed agent/container path is live.

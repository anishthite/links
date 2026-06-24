#!/usr/bin/env bash
# graph-ideas.sh — pull notes from board-db (D1, remote) and plot ideas over time.
#
# Usage:
#   ./graph-ideas.sh            # remote D1 (default)
#   ./graph-ideas.sh --local    # local D1 (wrangler d1 --local)
#   ./graph-ideas.sh --open     # also open the resulting PNG/HTML
#
# Re-run anytime. Writes ideas-over-time.png / .html / ideas-summary.json next to
# this script. The query is read-only (SELECT-only), safe to run as often as you like.
#
# DB identity (from wrangler.toml):
#   name = board-db
#   id   = 9caa972d-f4d1-4262-81d0-f991e65dbdfa
#   binding = DB

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

REMOTE_FLAG="--remote"
DO_OPEN=0
for arg in "$@"; do
  case "$arg" in
    --local)  REMOTE_FLAG="--local" ;;
    --remote) REMOTE_FLAG="--remote" ;;
    --open)   DO_OPEN=1 ;;
    -h|--help)
      sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)
      echo "graph-ideas.sh: unknown flag '$arg'" >&2
      exit 2 ;;
  esac
done

# --- 1. Pull notes via wrangler -----------------------------------------------
#
# We pull every column we need in one shot; the python script filters to
# `tag = "idea"` or `#idea` in text. Reverse-chrono so the latest row is first,
# but ordering doesn't matter for the plot.
#
# NOTE: we deliberately do NOT export CLOUDFLARE_ACCOUNT_ID here — the wrangler
# OAuth token already binds to the right account, and forcing the header has
# caused 7403 "account not authorized" errors before (see implementation-notes
# D-107 in the repo).
QUERY='SELECT uuid, text, tags, color, created_at, updated_at FROM notes ORDER BY created_at DESC;'

echo "→ Querying board-db ($REMOTE_FLAG)..." >&2
TMP_JSON="$(mktemp -t board-ideas.XXXXXX.json)"
trap 'rm -f "$TMP_JSON"' EXIT

if ! npx --yes wrangler d1 execute board-db "$REMOTE_FLAG" --json --command "$QUERY" > "$TMP_JSON" 2>/tmp/wrangler-ideas.err; then
  echo "✗ wrangler query failed. stderr:" >&2
  cat /tmp/wrangler-ideas.err >&2
  exit 1
fi

ROW_COUNT=$(python3 -c "import json,sys; d=json.load(open('$TMP_JSON')); print(sum(len(s.get('results',[])) for s in (d if isinstance(d,list) else [d])))")
echo "→ Got $ROW_COUNT notes." >&2

# --- 2. Plot ------------------------------------------------------------------
echo "→ Plotting..." >&2
python3 "$HERE/graph-ideas.py" < "$TMP_JSON"

# --- 3. Optionally open -------------------------------------------------------
if [ "$DO_OPEN" -eq 1 ]; then
  case "$(uname -s)" in
    Darwin) open "$HERE/ideas-over-time.html" ;;
    Linux)  xdg-open "$HERE/ideas-over-time.html" >/dev/null 2>&1 || true ;;
  esac
fi

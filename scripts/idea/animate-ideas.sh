#!/usr/bin/env bash
# animate-ideas.sh — pull notes from board-db (D1, remote) and render a
# time-lapse animation of ideas per month.
#
# Usage:
#   ./animate-ideas.sh            # remote D1 (default), writes MP4 + GIF
#   ./animate-ideas.sh --local    # local D1
#   ./animate-ideas.sh --open     # also open the resulting MP4
#
# Outputs (next to this script):
#   ideas-over-time.mp4   — H.264, ~12s loop, social-friendly 1440x810
#   ideas-over-time.gif   — autoplay-everywhere fallback
#
# Requires ffmpeg on PATH (used by matplotlib's FFMpegWriter).
#
# DB identity (from wrangler.toml):
#   name = board-db
#   binding = DB
#
# NOTE: like graph-ideas.sh, we deliberately do NOT export
# CLOUDFLARE_ACCOUNT_ID — the wrangler OAuth token binds correctly on its
# own, and forcing the header has caused 7403 errors in the past.

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
      sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)
      echo "animate-ideas.sh: unknown flag '$arg'" >&2
      exit 2 ;;
  esac
done

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "✗ ffmpeg not found on PATH. brew install ffmpeg." >&2
  exit 1
fi

QUERY='SELECT uuid, text, tags, color, created_at, updated_at FROM notes ORDER BY created_at DESC;'

echo "→ Querying board-db ($REMOTE_FLAG)..." >&2
TMP_JSON="$(mktemp -t board-ideas-anim.XXXXXX.json)"
trap 'rm -f "$TMP_JSON"' EXIT

if ! npx --yes wrangler d1 execute board-db "$REMOTE_FLAG" --json --command "$QUERY" > "$TMP_JSON" 2>/tmp/wrangler-ideas-anim.err; then
  echo "✗ wrangler query failed. stderr:" >&2
  cat /tmp/wrangler-ideas-anim.err >&2
  exit 1
fi

ROW_COUNT=$(python3 -c "import json,sys; d=json.load(open('$TMP_JSON')); print(sum(len(s.get('results',[])) for s in (d if isinstance(d,list) else [d])))")
echo "→ Got $ROW_COUNT notes." >&2

echo "→ Rendering animation (this takes ~30-90s)..." >&2
python3 "$HERE/animate-ideas.py" < "$TMP_JSON"

if [ "$DO_OPEN" -eq 1 ]; then
  case "$(uname -s)" in
    Darwin) open "$HERE/ideas-over-time.mp4" ;;
    Linux)  xdg-open "$HERE/ideas-over-time.mp4" >/dev/null 2>&1 || true ;;
  esac
fi

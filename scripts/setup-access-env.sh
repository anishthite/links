#!/usr/bin/env bash
# Fetch the AUD tag and team domain from Cloudflare's Access API and push them
# into the Pages project's production env as secrets via wrangler.
#
# Why: wrangler can't *create* an Access application (that lives in Zero Trust,
# not in Pages/Workers), but once the app exists we can fully automate the
# remaining wiring instead of round-tripping through the dashboard.
#
# Prereqs:
#   1. The Access application already exists (you did that in the dashboard).
#   2. A Cloudflare API token with these scopes (create one at
#      https://dash.cloudflare.com/profile/api-tokens):
#        - Account → Access: Apps and Policies → Read
#        - Account → Account Settings → Read
#      Export it as CLOUDFLARE_API_TOKEN before running.
#   3. `jq` installed (`brew install jq`).
#   4. `wrangler` available (already a devDep).
#
# Usage:
#     export CLOUDFLARE_API_TOKEN=...
#     ./scripts/setup-access-env.sh
#
# Optional overrides:
#     ACCOUNT_ID=...           # default: read from wrangler.toml comment
#     APP_DOMAIN=...           # default: board.thite.site (matches your app)
#     PAGES_PROJECT=...        # default: board

set -euo pipefail

# ---- config -----------------------------------------------------------------
ACCOUNT_ID="${ACCOUNT_ID:-38136d7e8e51d4450fd5687cdba2ce2a}"   # from wrangler.toml D-107 comment
APP_DOMAIN="${APP_DOMAIN:-board.thite.site}"
PAGES_PROJECT="${PAGES_PROJECT:-board}"

# ---- preflight --------------------------------------------------------------
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN not set. See header.}"
command -v jq >/dev/null   || { echo "need jq (brew install jq)"; exit 1; }
command -v npx >/dev/null  || { echo "need npx"; exit 1; }

api() {
  curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
          -H "Content-Type: application/json" \
          "$@"
}

# ---- 1. team domain (e.g. anishthite.cloudflareaccess.com) ------------------
echo "› Fetching team domain..."
TEAM_DOMAIN=$(api "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/organizations" \
  | jq -er '.result.auth_domain')
echo "  $TEAM_DOMAIN"

# ---- 2. find the Access app and read its AUD --------------------------------
echo "› Finding Access app for $APP_DOMAIN..."
APP_JSON=$(api "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps?per_page=100" \
  | jq --arg d "$APP_DOMAIN" '
      .result[]
      | select(
          .domain == $d
          or (.self_hosted_domains // [])[] == $d
          or (.destinations // [])[].uri == $d
        )
    ' | head -c 1MB)

if [[ -z "$APP_JSON" ]]; then
  echo "✗ No Access app found with destination $APP_DOMAIN."
  echo "  Create it in the Zero Trust dashboard first, then re-run."
  exit 1
fi

AUD=$(jq -er '.aud' <<<"$APP_JSON")
APP_NAME=$(jq -er '.name' <<<"$APP_JSON")
echo "  app: $APP_NAME  ·  aud: ${AUD:0:8}…${AUD: -4}"

# ---- 3. push into Pages project as secrets ----------------------------------
# wrangler pages secret put is interactive — pipe via stdin to make it silent.
echo "› Writing ACCESS_TEAM_DOMAIN to Pages project '$PAGES_PROJECT'..."
echo -n "$TEAM_DOMAIN" | npx --yes wrangler pages secret put ACCESS_TEAM_DOMAIN \
  --project-name="$PAGES_PROJECT" 1>/dev/null

echo "› Writing ACCESS_AUD to Pages project '$PAGES_PROJECT'..."
echo -n "$AUD" | npx --yes wrangler pages secret put ACCESS_AUD \
  --project-name="$PAGES_PROJECT" 1>/dev/null

echo
echo "✓ Done. Redeploy (or it'll take effect on next deploy):"
echo "    npm run deploy"

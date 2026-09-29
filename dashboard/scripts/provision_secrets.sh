#!/usr/bin/env bash
# Provision the dashboard secrets. For the owner to run once, on the Mac that runs the publisher,
# from a checkout where this dashboard/ folder is linked to the Vercel project (`vercel link`).
#
# Running it again ROTATES every secret: new values go to Vercel and to ~/trading/.env together.
# Redeploy production afterwards so the new values take effect, and re-subscribe to the new ntfy topic.
#
# Secret values are never printed. The only output is the ntfy topic and how to subscribe to it.
set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/trading/.env}"
INGEST_URL="https://lab.algorythmos.com/api/ingest"

cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }; }
need openssl
need vercel
need python3

say() { printf '%s\n' "$*" >&2; }

# Set NAME for one Vercel environment, reading the value from stdin (never from argv).
vercel_set() {
  local name="$1" target="$2" value="$3"
  vercel env rm "$name" "$target" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$name" "$target" >/dev/null
  say "vercel: set $name ($target)"
}

# Insert or replace NAME=VALUE in $ENV_FILE, keeping every other line and mode 600.
upsert() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  chmod 600 "$tmp"
  grep -v -E "^[[:space:]]*(export[[:space:]]+)?${name}=" "$ENV_FILE" >"$tmp" || true
  printf '%s=%s\n' "$name" "$value" >>"$tmp"
  mv -f "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "env: set $name in $ENV_FILE"
}

umask 077
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

INGEST_SECRET="$(openssl rand -hex 32)"
CRON_SECRET="$(openssl rand -hex 32)"
NTFY_TOPIC="tl-$(openssl rand -hex 12)"

# Vercel first: if any step fails, ~/trading/.env is left untouched and the run can simply be repeated.
vercel_set DASHBOARD_INGEST_SECRET production "$INGEST_SECRET"
vercel_set CRON_SECRET production "$CRON_SECRET"
vercel_set NTFY_TOPIC production "$NTFY_TOPIC"
vercel_set NTFY_TOPIC preview "$NTFY_TOPIC"

# The automation bypass lets the Mac's publisher (and nothing else) through Vercel Authentication.
BYPASS="$(
  vercel project protection enable --protection-bypass --format json | python3 -c '
import json, sys

def find(node):
    if isinstance(node, dict):
        pb = node.get("protectionBypass")
        if isinstance(pb, dict):
            for key, meta in pb.items():
                if isinstance(meta, dict) and meta.get("scope") == "automation-bypass":
                    return key
        for key in ("automationBypassSecret", "bypassSecret", "secret"):
            if isinstance(node.get(key), str) and node[key]:
                return node[key]
        for value in node.values():
            found = find(value)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = find(value)
            if found:
                return found
    return None

try:
    secret = find(json.load(sys.stdin))
except ValueError:
    secret = None
if not secret:
    sys.exit("could not read the automation bypass secret from the Vercel CLI output")
print(secret)
'
)"
say "vercel: automation bypass enabled"

upsert DASHBOARD_INGEST_SECRET "$INGEST_SECRET"
upsert CRON_SECRET "$CRON_SECRET"
upsert NTFY_TOPIC "$NTFY_TOPIC"
upsert DASHBOARD_INGEST_URL "$INGEST_URL"
upsert VERCEL_AUTOMATION_BYPASS_SECRET "$BYPASS"

unset INGEST_SECRET CRON_SECRET BYPASS

cat <<MSG

ntfy topic: ${NTFY_TOPIC}

To get watchdog alerts on your phone:
  1. Install the ntfy app (iOS App Store or Google Play).
  2. Tap + (Subscribe to topic), enter the topic above, keep the server as ntfy.sh, and subscribe.
  3. Keep the topic private: anyone who knows it can read the alerts.

Then redeploy production so the new secrets take effect.
MSG

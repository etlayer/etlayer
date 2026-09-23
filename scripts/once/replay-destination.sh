#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT_DIR/packages/cloudflare-ingest"
DEPLOY_LOG="/tmp/etlayer-replay-deploy.txt"

DESTINATION=""
FROM=""
TO=""
MAX_EVENTS="500"
PROJECT_ID="${ETLAYER_PROJECT_ID:-etlayer-default}"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/once/replay-destination.sh \
    --destination <posthog|statsig> \
    --from 2026-09-21T18:36:00Z \
    --to   2026-09-21T18:45:00Z \
    [--max-events 500]

The range is [from, to): from is inclusive, to is exclusive.
Only the named destination is invoked.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --destination)
      DESTINATION="${2:-}"
      shift 2
      ;;
    --from)
      FROM="${2:-}"
      shift 2
      ;;
    --to)
      TO="${2:-}"
      shift 2
      ;;
    --max-events)
      MAX_EVENTS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

case "$DESTINATION" in
  posthog|statsig)
    ;;
  *)
    usage
    die "--destination must be posthog or statsig"
    ;;
esac

[ -n "$FROM" ] || { usage; die "--from is required"; }
[ -n "$TO" ] || { usage; die "--to is required"; }

node -e '
  const [from, to] = process.argv.slice(1).map((value) => new Date(value));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    process.exit(1);
  }
' "$FROM" "$TO" || die "Invalid replay time range."

if ! [[ "$MAX_EVENTS" =~ ^[0-9]+$ ]] || [ "$MAX_EVENTS" -lt 1 ] || [ "$MAX_EVENTS" -gt 5000 ]; then
  die "--max-events must be an integer between 1 and 5000."
fi

cd "$ROOT_DIR"

npx wrangler whoami >/dev/null 2>&1 ||
  die "Wrangler is not authenticated. Run: npx wrangler login"

REPLAY_KEY="$(openssl rand -hex 32)"
REPLAY_ID="replay-${DESTINATION}-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"

cd "$APP_DIR"

say "Rotating one-time ETLAYER_REPLAY_KEY"
printf '%s' "$REPLAY_KEY" | npx wrangler secret put ETLAYER_REPLAY_KEY

say "Deploying replay-capable Worker"
npx wrangler deploy | tee "$DEPLOY_LOG"

WORKER_URL="$(
  grep -Eo 'https://[^[:space:]]+\.workers\.dev' "$DEPLOY_LOG" |
    tail -n 1 || true
)"

[ -n "$WORKER_URL" ] ||
  die "Could not parse the workers.dev URL from Wrangler output."

BODY="$(
  node -e '
    const [projectId, from, to, replayId, maxEvents] =
      process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      projectId,
      from,
      to,
      replayId,
      maxEvents: Number(maxEvents),
    }));
  ' "$PROJECT_ID" "$FROM" "$TO" "$REPLAY_ID" "$MAX_EVENTS"
)"

say "Replaying archived events to $DESTINATION"
printf 'Project: %s\n' "$PROJECT_ID"
printf 'Destination: %s\n' "$DESTINATION"
printf 'Range: [%s, %s)\n' "$FROM" "$TO"
printf 'Replay ID: %s\n' "$REPLAY_ID"

RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -X POST "$WORKER_URL/_ops/replay/$DESTINATION" \
    -H "authorization: Bearer $REPLAY_KEY" \
    -H "content-type: application/json" \
    --data "$BODY"
)"

if command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$RESPONSE" | jq
else
  printf '%s\n' "$RESPONSE"
fi

unset REPLAY_KEY

say "Replay request completed"

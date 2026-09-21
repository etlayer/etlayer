#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WORKER_NAME="etlayer-ingest"
QUEUE_NAME="etlayer-events"
R2_BUCKET="etlayer-events-archive"
WORKER_URL="https://etlayer-ingest.sergii-ponomarov.workers.dev"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

generate_ingest_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
}

archive_key_for() {
  local event_id="$1"
  local run_id="$2"
  local stamp="${run_id#local-}"

  if [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
    printf 'events/%s/%s/%s/%s/%s.json' \
      "${stamp:0:4}" "${stamp:4:2}" "${stamp:6:2}" "${stamp:9:2}" "$event_id"
    return
  fi

  return 1
}

check_previous_archive() {
  local event_id="${1:-}"
  local run_id="${2:-}"

  [ -n "$event_id" ] || return 0
  [ -n "$run_id" ] || return 0

  local key
  key="$(archive_key_for "$event_id" "$run_id" || true)"

  [ -n "$key" ] || {
    say "Could not derive R2 key from previous run id: $run_id"
    return 0
  }

  say "Checking previous smoke in remote R2"
  printf 'R2 key: %s/%s\n' "$R2_BUCKET" "$key"

  if npx wrangler r2 object get "$R2_BUCKET/$key" --remote --pipe >/tmp/etlayer-previous-event.json 2>/tmp/etlayer-r2-get.err; then
    printf 'R2: FOUND ✓\n'
    cat /tmp/etlayer-previous-event.json
    printf '\n'
  else
    printf 'R2: NOT FOUND ✗\n'
    cat /tmp/etlayer-r2-get.err >&2
  fi
}

main() {
  cd "$APP_DIR"

  say "ETLayer smoke diagnosis"

  say "Checking Queue consumer binding"
  npx wrangler queues consumer list "$QUEUE_NAME" --json

  check_previous_archive "${1:-}" "${2:-}"

  local ingest_key
  ingest_key="$(generate_ingest_key)"

  say "Rotating ETLAYER_INGEST_KEY for this diagnostic smoke"
  printf '%s' "$ingest_key" | npx wrangler secret put ETLAYER_INGEST_KEY

  local tail_log="/tmp/etlayer-tail-$$.log"
  local smoke_log="/tmp/etlayer-smoke-$$.log"

  say "Starting live Worker tail"
  npx wrangler tail "$WORKER_NAME" --format json >"$tail_log" 2>&1 &
  local tail_pid=$!

  cleanup() {
    kill "$tail_pid" >/dev/null 2>&1 || true
    wait "$tail_pid" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  sleep 4

  local run_id="diagnose-$(date -u +%Y%m%dT%H%M%SZ)"

  say "Sending diagnostic OTLP smoke"
  cd "$ROOT_DIR"
  ETLAYER_BASE_URL="$WORKER_URL" \
  ETLAYER_INGEST_KEY="$ingest_key" \
  ETLAYER_TEST_RUN_ID="$run_id" \
    npm run smoke:posthog 2>&1 | tee "$smoke_log"

  local smoke_json
  smoke_json="$(grep -E '^\{"ok":true' "$smoke_log" | tail -n 1 || true)"
  [ -n "$smoke_json" ] || die "Smoke request did not produce a success JSON line."

  local event_id
  event_id="$(node -e 'console.log(JSON.parse(process.argv[1]).eventId)' "$smoke_json")"

  say "Waiting for Queue consumer attempts"
  sleep 12

  cleanup
  trap - EXIT

  say "Relevant Worker tail lines"
  if ! grep -E 'ETLayer|PostHog|failed to process|projected|persisted|exception|error' "$tail_log"; then
    printf 'No matching structured log lines. Full tail follows:\n'
    cat "$tail_log"
  fi

  local now_hour
  now_hour="$(date -u +%Y/%m/%d/%H)"
  local key="events/$now_hour/$event_id.json"

  say "Checking diagnostic smoke in remote R2"
  printf 'R2 key: %s/%s\n' "$R2_BUCKET" "$key"

  if npx wrangler r2 object get "$R2_BUCKET/$key" --remote --pipe >/tmp/etlayer-diagnostic-event.json 2>/tmp/etlayer-r2-get.err; then
    printf 'R2: FOUND ✓\n'
    cat /tmp/etlayer-diagnostic-event.json
    printf '\n'
  else
    printf 'R2: NOT FOUND ✗\n'
    cat /tmp/etlayer-r2-get.err >&2
  fi

  printf '\nDiagnostic coordinates:\n'
  printf 'eventId=%s\n' "$event_id"
  printf 'runId=%s\n' "$run_id"
  printf 'tailLog=%s\n' "$tail_log"
}

main "$@"

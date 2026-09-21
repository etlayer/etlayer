#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ETLAYER_DIR="$ROOT_DIR/packages/cloudflare-ingest"
FIXTURE_DIR="$ROOT_DIR/examples/cloudflare-fixture"
STATE_BUCKET="etlayer-fixture-state"
ETLAYER_URL="https://etlayer-ingest.sergii-ponomarov.workers.dev"
ETLAYER_OTLP_ENDPOINT="$ETLAYER_URL/v1/logs"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

generate_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
  fi
}

cd "$ROOT_DIR"
npx wrangler whoami >/dev/null 2>&1 ||
  die "Wrangler is not authenticated. Run: npx wrangler login"

if ! git diff --quiet -- examples/cloudflare-fixture/wrangler.jsonc; then
  die "Fixture wrangler.jsonc has local changes. Restore it first: git restore examples/cloudflare-fixture/wrangler.jsonc"
fi

say "Ensuring fixture state bucket exists"
cd "$FIXTURE_DIR"
if npx wrangler r2 bucket list 2>/dev/null | grep -Fq "$STATE_BUCKET"; then
  printf 'R2 bucket already exists: %s\n' "$STATE_BUCKET"
else
  CI=1 npx wrangler r2 bucket create "$STATE_BUCKET"
fi

INGEST_KEY="$(generate_key)"

say "Rotating shared ETLayer fixture ingest credential"
cd "$ETLAYER_DIR"
printf '%s' "$INGEST_KEY" | npx wrangler secret put ETLAYER_INGEST_KEY

say "Deploying current ETLayer Worker"
npx wrangler deploy >/tmp/etlayer-fixture-etlayer-deploy.txt
cat /tmp/etlayer-fixture-etlayer-deploy.txt

say "Configuring fixture ingest credential"
cd "$FIXTURE_DIR"
printf '%s' "$INGEST_KEY" | npx wrangler secret put ETLAYER_INGEST_KEY

say "Deploying producer fixture"
npx wrangler deploy | tee /tmp/etlayer-fixture-deploy.txt

FIXTURE_URL="$(
  grep -Eo 'https://[^[:space:]]+\.workers\.dev' /tmp/etlayer-fixture-deploy.txt |
    tail -n 1 || true
)"

[ -n "$FIXTURE_URL" ] ||
  die "Could not parse fixture workers.dev URL."

health_check() {
  local url="$1"
  local attempts=10

  for attempt in $(seq 1 "$attempts"); do
    if body="$(curl --fail --silent --show-error "$url/health" 2>/dev/null)"; then
      printf '%s\n' "$body"
      return 0
    fi

    if [ "$attempt" -lt "$attempts" ]; then
      sleep 1
    fi
  done

  printf '\nHealth check failed after %s attempts: %s/health\n' "$attempts" "$url" >&2
  printf 'GET / response for diagnosis:\n' >&2
  curl --silent --show-error --include "$url/" >&2 || true
  return 1
}

say "Health checks"
health_check "$ETLAYER_URL"
health_check "$FIXTURE_URL"

say "Authenticated ETLayer OTLP preflight"
PREFLIGHT_EVENT_ID="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
PREFLIGHT_NOW_NANO="$(python3 - <<'PY'
import time
print(time.time_ns())
PY
)"

PREFLIGHT_BODY="$(
  node -e '
    const [eventId, nowNano] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      resourceLogs: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "etlayer-fixture-preflight" } },
            { key: "deployment.environment.name", value: { stringValue: "acceptance" } }
          ]
        },
        scopeLogs: [{
          scope: { name: "etlayer.fixture.preflight", version: "0.1.0" },
          logRecords: [{
            eventName: "etlayer.acceptance.fixture_preflight",
            timeUnixNano: nowNano,
            observedTimeUnixNano: nowNano,
            attributes: [
              { key: "etlayer.event.id", value: { stringValue: eventId } },
              { key: "etlayer.schema.version", value: { intValue: "1" } }
            ]
          }]
        }]
      }]
    }));
  ' "$PREFLIGHT_EVENT_ID" "$PREFLIGHT_NOW_NANO"
)"

PREFLIGHT_RESPONSE="$(
  curl --fail-with-body --silent --show-error     -X POST "$ETLAYER_OTLP_ENDPOINT"     -H "authorization: Bearer $INGEST_KEY"     -H "content-type: application/json"     --data "$PREFLIGHT_BODY"
)" || die "Authenticated OTLP preflight failed: $ETLAYER_OTLP_ENDPOINT"

printf 'OTLP endpoint: %s\n' "$ETLAYER_OTLP_ENDPOINT"
printf 'Preflight event id: %s\n' "$PREFLIGHT_EVENT_ID"
printf 'Preflight response: %s\n' "$PREFLIGHT_RESPONSE"

say "Fixture browser-event preflight"
FIXTURE_PREFLIGHT_RUN="fixture-preflight-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
COOKIE_JAR="/tmp/etlayer-fixture-cookies-$.txt"
trap 'rm -f "$COOKIE_JAR"' EXIT

curl --fail --silent --show-error   -c "$COOKIE_JAR"   "$FIXTURE_URL/?run=$FIXTURE_PREFLIGHT_RUN"   >/dev/null

FIXTURE_PREFLIGHT_RESPONSE="$(
  curl --fail-with-body --silent --show-error     -b "$COOKIE_JAR"     -X POST "$FIXTURE_URL/api/browser-event"     -H "content-type: application/json"     --data '{"eventName":"landing.hero.exposed","attributes":{"page.path":"/preflight"}}'
)" || {
  printf '\nFixture runtime config:\n' >&2
  curl --silent --show-error "$FIXTURE_URL/health" >&2 || true
  printf '\n' >&2
  die "Fixture browser-event preflight failed."
}

printf 'Fixture preflight response: %s\n' "$FIXTURE_PREFLIGHT_RESPONSE"
rm -f "$COOKIE_JAR"
trap - EXIT

RUN_ID="vs1-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
RUN_URL="$FIXTURE_URL/?run=$RUN_ID"

unset INGEST_KEY

say "Fixture ready"
printf 'correlation.id: %s\n' "$RUN_ID"
printf 'Open exactly: %s\n' "$RUN_URL"
printf '\n'
printf 'Then complete the two enabled actions in order:\n'
printf '  1. Try ETLayer\n'
printf '  2. Create test account\n'
printf '\n'
printf 'The page will show all three event IDs when the funnel is complete.\n'

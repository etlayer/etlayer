#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WORKER_NAME="etlayer-ingest"
QUEUE_NAME="etlayer-events"
DLQ_NAME="etlayer-events-dlq"
R2_BUCKET="etlayer-events-archive"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

ensure_node() {
  have node || die "Node.js is required."
  have npm || die "npm is required."
}

ensure_dependencies() {
  cd "$ROOT_DIR"

  if [ ! -d node_modules/wrangler ]; then
    say "Installing repository dependencies..."
    npm install
  fi

  npx wrangler --version >/dev/null 2>&1 ||
    die "Wrangler is not available through npx."
}

ensure_cloudflare_auth() {
  say "Checking Cloudflare authentication"

  if npx wrangler whoami >/tmp/etlayer-wrangler-whoami.txt 2>&1; then
    cat /tmp/etlayer-wrangler-whoami.txt
    return
  fi

  say "Wrangler is not authenticated. Starting browser login..."
  npx wrangler login

  npx wrangler whoami >/tmp/etlayer-wrangler-whoami.txt 2>&1 ||
    die "Wrangler authentication failed."

  cat /tmp/etlayer-wrangler-whoami.txt
}

ensure_cloudflare_resources() {
  cd "$APP_DIR"

  say "Ensuring Cloudflare Queue exists: $QUEUE_NAME"
  npx wrangler queues create "$QUEUE_NAME" >/tmp/etlayer-queue-create.txt 2>&1 || true
  cat /tmp/etlayer-queue-create.txt

  say "Ensuring Cloudflare DLQ exists: $DLQ_NAME"
  npx wrangler queues create "$DLQ_NAME" >/tmp/etlayer-dlq-create.txt 2>&1 || true
  cat /tmp/etlayer-dlq-create.txt

  say "Ensuring R2 bucket exists: $R2_BUCKET"
  npx wrangler r2 bucket create "$R2_BUCKET" >/tmp/etlayer-r2-create.txt 2>&1 || true
  cat /tmp/etlayer-r2-create.txt
}

generate_ingest_key() {
  if have openssl; then
    openssl rand -hex 32
    return
  fi

  if have python3; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
    return
  fi

  die "Need either openssl or python3 to generate ETLAYER_INGEST_KEY."
}

prompt_posthog_token() {
  if [ -n "${POSTHOG_PROJECT_TOKEN:-}" ]; then
    printf '%s' "$POSTHOG_PROJECT_TOKEN"
    return
  fi

  local token=""
  printf '\nPostHog Project API token for project ETLayer (hidden input): ' >&2
  IFS= read -r -s token
  printf '\n' >&2

  [ -n "$token" ] || die "POSTHOG_PROJECT_TOKEN cannot be empty."

  if [[ "$token" != phc_* ]]; then
    printf 'WARNING: PostHog project tokens normally start with phc_. Continuing.\n' >&2
  fi

  printf '%s' "$token"
}

set_worker_secret() {
  local name="$1"
  local value="$2"

  printf '%s' "$value" |
    npx wrangler secret put "$name"
}

deploy_worker() {
  cd "$APP_DIR"

  say "Deploying $WORKER_NAME"
  npx wrangler deploy | tee /tmp/etlayer-deploy.txt

  local url
  url="$(
    grep -Eo 'https://[^[:space:]]+\.workers\.dev' /tmp/etlayer-deploy.txt |
      tail -n 1 || true
  )"

  if [ -z "$url" ]; then
    url="https://$WORKER_NAME.${CLOUDFLARE_SUBDOMAIN:-}.workers.dev"
  fi

  printf '%s' "$url"
}

health_check() {
  local url="$1"

  if [[ "$url" == *"..workers.dev"* ]] || [ -z "$url" ]; then
    say "Could not infer workers.dev URL automatically; skipping health check."
    return
  fi

  say "Checking $url/health"
  curl --fail --silent --show-error "$url/health"
  printf '\n'
}

run_smoke() {
  local url="$1"
  local ingest_key="$2"

  if [[ "$url" == *"..workers.dev"* ]] || [ -z "$url" ]; then
    say "Could not infer workers.dev URL automatically; skipping smoke."
    printf 'Run manually once you know the URL:\n'
    printf 'ETLAYER_BASE_URL=https://... ETLAYER_INGEST_KEY=<key> npm run smoke:posthog\n'
    return
  fi

  cd "$ROOT_DIR"

  say "Sending ETLayer OTLP smoke event"
  ETLAYER_BASE_URL="$url"   ETLAYER_INGEST_KEY="$ingest_key"   ETLAYER_TEST_RUN_ID="local-$(date -u +%Y%m%dT%H%M%SZ)"     npm run smoke:posthog
}

main() {
  cd "$ROOT_DIR"

  say "ETLayer one-time local Cloudflare bootstrap"
  printf 'Repository root: %s\n' "$ROOT_DIR"

  ensure_node
  ensure_dependencies
  ensure_cloudflare_auth
  ensure_cloudflare_resources

  local ingest_key
  ingest_key="$(generate_ingest_key)"

  local posthog_token
  posthog_token="$(prompt_posthog_token)"

  cd "$APP_DIR"

  say "Configuring Worker secrets"
  set_worker_secret "ETLAYER_INGEST_KEY" "$ingest_key"
  set_worker_secret "POSTHOG_PROJECT_TOKEN" "$posthog_token"

  unset posthog_token

  local worker_url
  worker_url="$(deploy_worker)"

  health_check "$worker_url"
  run_smoke "$worker_url" "$ingest_key"

  printf '\n'
  printf 'Bootstrap complete.\n'
  printf 'Worker: %s\n' "$worker_url"
  printf 'ETLAYER_INGEST_KEY was generated locally and was not written to disk.\n'
  printf 'Keep this terminal open only if you need the current shell state; rerunning the script rotates the ingest key.\n'

  unset ingest_key
}

main "$@"

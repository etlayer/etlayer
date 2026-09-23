#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
FIXTURE_DIR="$ROOT_DIR/examples/cloudflare-fixture"

INGEST_QUEUE="etlayer-events-ci"
DLQ="etlayer-events-ci-dlq"
ARCHIVE_BUCKET="etlayer-events-archive-ci"
FIXTURE_BUCKET="etlayer-fixture-state-ci"
INGEST_URL="https://etlayer-ingest-ci.sergii-ponomarov.workers.dev"
FIXTURE_URL="https://etlayer-cloudflare-fixture-ci.sergii-ponomarov.workers.dev"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

ensure_r2_bucket() {
  local name="$1"

  if (
    cd "$INGEST_DIR"
    npx wrangler r2 bucket list 2>/dev/null | grep -Fq "$name"
  ); then
    printf 'R2 bucket exists: %s\n' "$name"
    return
  fi

  (
    cd "$INGEST_DIR"
    npx wrangler r2 bucket create "$name"
  )
}

ensure_queue() {
  local name="$1"

  if (
    cd "$INGEST_DIR"
    npx wrangler queues list 2>/dev/null | grep -Fq "$name"
  ); then
    printf 'Queue exists: %s\n' "$name"
    return
  fi

  (
    cd "$INGEST_DIR"
    npx wrangler queues create "$name"
  )
}

read_secret() {
  local env_name="$1"
  local prompt="$2"
  local value="${!env_name:-}"

  if [ -n "$value" ]; then
    printf '%s' "$value"
    return
  fi

  if [ ! -t 0 ]; then
    die "$env_name is required in non-interactive mode."
  fi

  read -r -s -p "$prompt: " value
  printf '\n' >&2

  [ -n "$value" ] || die "$env_name cannot be empty."
  printf '%s' "$value"
}

put_ingest_secret() {
  local name="$1"
  local value="$2"

  (
    cd "$INGEST_DIR"
    printf '%s' "$value" |
      npx wrangler secret put "$name" --env ci >/dev/null
  )
}

validate_master_key() {
  local name="$1"
  local value="$2"

  if ! printf '%s' "$value" | grep -Eq '^[0-9a-fA-F]{64}
health_check() {
  local url="$1"

  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error "$url/health" >/dev/null 2>&1; then
      printf 'healthy: %s\n' "$url"
      return 0
    fi

    sleep 1
  done

  return 1
}

cd "$ROOT_DIR"
npx wrangler whoami ||
  die "Wrangler is not authenticated. Run: npx wrangler login"

say "Creating isolated CI resources"
ensure_r2_bucket "$ARCHIVE_BUCKET"
ensure_r2_bucket "$FIXTURE_BUCKET"
ensure_queue "$INGEST_QUEUE"
ensure_queue "$DLQ"

say "Deploying CI ingest Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env ci
)

say "Deploying CI fixture Worker"
(
  cd "$FIXTURE_DIR"
  npx wrangler deploy --env ci
)

say "Configuring persistent CI encryption roots"
printf 'Generate each key once with: openssl rand -hex 32\n'
printf 'Keep these values stable for the lifetime of encrypted CI records.\n'
printf 'They are sent directly to Cloudflare as Worker secrets and are not stored in GitHub.\n'

DESTINATION_MASTER_KEY="$(
  read_secret \
    ETLAYER_CI_DESTINATION_SECRET_KEY_V1 \
    "Paste stable CI destination master key v1"
)"
IDEMPOTENCY_MASTER_KEY="$(
  read_secret \
    ETLAYER_CI_IDEMPOTENCY_SECRET_KEY_V1 \
    "Paste stable CI idempotency master key v1"
)"

validate_master_key \
  ETLAYER_CI_DESTINATION_SECRET_KEY_V1 \
  "$DESTINATION_MASTER_KEY"
validate_master_key \
  ETLAYER_CI_IDEMPOTENCY_SECRET_KEY_V1 \
  "$IDEMPOTENCY_MASTER_KEY"

put_ingest_secret \
  ETLAYER_DESTINATION_SECRET_KEY_V1 \
  "$DESTINATION_MASTER_KEY"
put_ingest_secret \
  ETLAYER_IDEMPOTENCY_SECRET_KEY_V1 \
  "$IDEMPOTENCY_MASTER_KEY"

unset DESTINATION_MASTER_KEY
unset IDEMPOTENCY_MASTER_KEY

say "Configuring persistent CI destination provider credentials"
printf 'These values are sent directly to Cloudflare as Worker secrets and are not stored in GitHub.\n'

POSTHOG_TOKEN="$(
  read_secret     ETLAYER_CI_POSTHOG_PROJECT_TOKEN     "Paste ETLayer PostHog project token"
)"
STATSIG_SECRET="$(
  read_secret     ETLAYER_CI_STATSIG_SERVER_SECRET     "Paste ETLayer Statsig server secret"
)"

put_ingest_secret POSTHOG_PROJECT_TOKEN "$POSTHOG_TOKEN"
put_ingest_secret STATSIG_SERVER_SECRET "$STATSIG_SECRET"

unset POSTHOG_TOKEN
unset STATSIG_SECRET

say "Checking isolated CI Workers"
health_check "$INGEST_URL" ||
  die "CI ingest Worker is not healthy: $INGEST_URL"
health_check "$FIXTURE_URL" ||
  die "CI fixture Worker is not healthy: $FIXTURE_URL"

say "Cloudflare CI bootstrap complete"
cat <<EOF
CI Workers:
  $INGEST_URL
  $FIXTURE_URL

CI resources:
  Queue: $INGEST_QUEUE
  DLQ: $DLQ
  R2 archive: $ARCHIVE_BUCKET
  R2 fixture state: $FIXTURE_BUCKET

Next:
  1. Preserve ETLAYER_CI_DESTINATION_SECRET_KEY_V1 and ETLAYER_CI_IDEMPOTENCY_SECRET_KEY_V1 securely for disaster recovery.
  2. Create a dedicated Cloudflare API token for GitHub.
  3. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as GitHub repository secrets.
  4. Do not add PostHog, Statsig, ETLayer ingest, operator, or encryption master secrets to GitHub.
  5. Do not rotate either v1 master key from acceptance scripts; introduce a new key version for future rotation.
EOF
; then
    die "$name must be exactly 64 hexadecimal characters (32 bytes)."
  fi
}

health_check() {
  local url="$1"

  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error "$url/health" >/dev/null 2>&1; then
      printf 'healthy: %s\n' "$url"
      return 0
    fi

    sleep 1
  done

  return 1
}

cd "$ROOT_DIR"
npx wrangler whoami ||
  die "Wrangler is not authenticated. Run: npx wrangler login"

say "Creating isolated CI resources"
ensure_r2_bucket "$ARCHIVE_BUCKET"
ensure_r2_bucket "$FIXTURE_BUCKET"
ensure_queue "$INGEST_QUEUE"
ensure_queue "$DLQ"

say "Deploying CI ingest Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env ci
)

say "Deploying CI fixture Worker"
(
  cd "$FIXTURE_DIR"
  npx wrangler deploy --env ci
)

say "Configuring persistent CI destination credentials"
printf 'These values are sent directly to Cloudflare as Worker secrets and are not stored in GitHub.\n'

POSTHOG_TOKEN="$(
  read_secret     ETLAYER_CI_POSTHOG_PROJECT_TOKEN     "Paste ETLayer PostHog project token"
)"
STATSIG_SECRET="$(
  read_secret     ETLAYER_CI_STATSIG_SERVER_SECRET     "Paste ETLayer Statsig server secret"
)"

put_ingest_secret POSTHOG_PROJECT_TOKEN "$POSTHOG_TOKEN"
put_ingest_secret STATSIG_SERVER_SECRET "$STATSIG_SECRET"

unset POSTHOG_TOKEN
unset STATSIG_SECRET

say "Checking isolated CI Workers"
health_check "$INGEST_URL" ||
  die "CI ingest Worker is not healthy: $INGEST_URL"
health_check "$FIXTURE_URL" ||
  die "CI fixture Worker is not healthy: $FIXTURE_URL"

say "Cloudflare CI bootstrap complete"
cat <<EOF
CI Workers:
  $INGEST_URL
  $FIXTURE_URL

CI resources:
  Queue: $INGEST_QUEUE
  DLQ: $DLQ
  R2 archive: $ARCHIVE_BUCKET
  R2 fixture state: $FIXTURE_BUCKET

Next:
  1. Create a dedicated Cloudflare API token for GitHub.
  2. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as GitHub repository secrets.
  3. Do not add PostHog, Statsig, ETLayer ingest, or ETLayer operator secrets to GitHub.
EOF

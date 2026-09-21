#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT_DIR/packages/cloudflare-ingest"

MODE="${1:-}"

case "$MODE" in
  disable)
    VALUE="1"
    ;;
  enable)
    VALUE="0"
    ;;
  *)
    printf 'Usage: %s <disable|enable>\n' "$0" >&2
    exit 2
    ;;
esac

cd "$APP_DIR"
printf '%s' "$VALUE" | npx wrangler secret put POSTHOG_EXPORT_DISABLED

if [ "$MODE" = "disable" ]; then
  printf '\nPostHog projection disabled. ETLayer will continue to archive events in R2.\n'
else
  printf '\nPostHog projection enabled.\n'
fi

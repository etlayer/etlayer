#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT_DIR/packages/cloudflare-ingest"

DESTINATION="${1:-}"
MODE="${2:-}"

case "$DESTINATION" in
  posthog)
    SECRET_NAME="POSTHOG_EXPORT_DISABLED"
    DISPLAY_NAME="PostHog"
    ;;
  statsig)
    SECRET_NAME="STATSIG_EXPORT_DISABLED"
    DISPLAY_NAME="Statsig"
    ;;
  *)
    printf 'Usage: %s <posthog|statsig> <disable|enable>\n' "$0" >&2
    exit 2
    ;;
esac

case "$MODE" in
  disable)
    VALUE="1"
    ;;
  enable)
    VALUE="0"
    ;;
  *)
    printf 'Usage: %s <posthog|statsig> <disable|enable>\n' "$0" >&2
    exit 2
    ;;
esac

cd "$APP_DIR"
printf '%s' "$VALUE" | npx wrangler secret put "$SECRET_NAME"

if [ "$MODE" = "disable" ]; then
  printf '\n%s projection disabled. Canonical R2 persistence and other destinations remain active.\n' "$DISPLAY_NAME"
else
  printf '\n%s projection enabled.\n' "$DISPLAY_NAME"
fi

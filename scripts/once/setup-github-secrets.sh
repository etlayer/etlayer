#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-etlayer/etlayer}"

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

install_gh_if_possible() {
  if have gh; then
    return
  fi

  if have brew; then
    say "GitHub CLI is missing. Installing it with Homebrew..."
    brew install gh
    return
  fi

  die "GitHub CLI (gh) is required. Install it, then rerun this script."
}

ensure_node() {
  have node || die "Node.js is required."
  have npm || die "npm is required."
}

ensure_gh_auth() {
  if gh auth status >/dev/null 2>&1; then
    return
  fi

  say "GitHub CLI is not authenticated. Starting gh auth login..."
  gh auth login
  gh auth status >/dev/null 2>&1 || die "GitHub authentication failed."
}

ensure_repo_access() {
  gh repo view "$REPO" >/dev/null 2>&1 ||
    die "Cannot access GitHub repository: $REPO"
}

ensure_wrangler() {
  if [ ! -d node_modules/wrangler ]; then
    say "Installing repository dependencies so Wrangler is available..."
    npm install
  fi

  npx wrangler --version >/dev/null 2>&1 ||
    die "Wrangler is not available through npx."
}

ensure_wrangler_auth() {
  if npx wrangler whoami >/tmp/etlayer-wrangler-whoami.txt 2>&1; then
    return
  fi

  say "Wrangler is not authenticated. Starting Cloudflare OAuth login..."
  npx wrangler login

  npx wrangler whoami >/tmp/etlayer-wrangler-whoami.txt 2>&1 ||
    die "Wrangler authentication failed."
}

detect_cloudflare_account_id() {
  local output account_id

  output="$(cat /tmp/etlayer-wrangler-whoami.txt 2>/dev/null || true)"

  account_id="$(
    printf '%s\n' "$output" |
      grep -Eo '[0-9a-fA-F]{32}' |
      head -n 1 || true
  )"

  if [ -n "$account_id" ]; then
    printf '%s' "$account_id"
    return
  fi

  printf ''
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

prompt_secret() {
  local label="$1"
  local var_name="$2"
  local value=""

  printf '%s: ' "$label" >&2
  IFS= read -r -s value
  printf '\n' >&2

  [ -n "$value" ] || die "$label cannot be empty."

  printf -v "$var_name" '%s' "$value"
}

prompt_value() {
  local label="$1"
  local var_name="$2"
  local default_value="${3:-}"
  local value=""

  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$label" "$default_value" >&2
  else
    printf '%s: ' "$label" >&2
  fi

  IFS= read -r value
  value="${value:-$default_value}"

  [ -n "$value" ] || die "$label cannot be empty."

  printf -v "$var_name" '%s' "$value"
}

set_github_secret() {
  local name="$1"
  local value="$2"

  printf '%s' "$value" |
    gh secret set "$name" --repo "$REPO"
}

main() {
  say "ETLayer one-time GitHub secret bootstrap"
  printf 'Repository: %s\n' "$REPO"

  install_gh_if_possible
  ensure_node
  ensure_gh_auth
  ensure_repo_access
  ensure_wrangler
  ensure_wrangler_auth

  local detected_account_id
  detected_account_id="$(detect_cloudflare_account_id)"

  local cloudflare_account_id
  prompt_value     "Cloudflare Account ID"     cloudflare_account_id     "$detected_account_id"

  local cloudflare_api_token
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    cloudflare_api_token="$CLOUDFLARE_API_TOKEN"
    say "Using CLOUDFLARE_API_TOKEN from the current shell environment."
  else
    printf '\nCloudflare API token is required for GitHub Actions CI/CD.\n'
    printf 'Wrangler OAuth login cannot safely be copied into GitHub Actions.\n'
    printf 'Create a scoped token in Cloudflare Dashboard, then paste it here.\n'
    prompt_secret "Cloudflare API Token" cloudflare_api_token
  fi

  local posthog_project_token
  if [ -n "${POSTHOG_PROJECT_TOKEN:-}" ]; then
    posthog_project_token="$POSTHOG_PROJECT_TOKEN"
    say "Using POSTHOG_PROJECT_TOKEN from the current shell environment."
  else
    printf '\nPaste the PostHog Project API token for project ETLayer.\n'
    printf 'It normally starts with phc_. Do not use a Personal API Key.\n'
    prompt_secret "PostHog Project Token" posthog_project_token
  fi

  if [[ "$posthog_project_token" != phc_* ]]; then
    printf '\nWARNING: PostHog project tokens normally start with phc_.\n' >&2
    printf 'Continuing because PostHog token formats can evolve.\n' >&2
  fi

  local etlayer_ingest_key
  etlayer_ingest_key="$(generate_ingest_key)"

  say "Writing encrypted repository secrets to GitHub"
  set_github_secret "CLOUDFLARE_API_TOKEN" "$cloudflare_api_token"
  set_github_secret "CLOUDFLARE_ACCOUNT_ID" "$cloudflare_account_id"
  set_github_secret "ETLAYER_INGEST_KEY" "$etlayer_ingest_key"
  set_github_secret "POSTHOG_PROJECT_TOKEN" "$posthog_project_token"

  unset cloudflare_api_token
  unset posthog_project_token
  unset etlayer_ingest_key

  say "Configured secrets"
  gh secret list --repo "$REPO"

  printf '\nDone. Secret values were not written to disk by this script.\n'
  printf 'Next: run the GitHub Actions workflow "Deploy and smoke".\n'
}

main "$@"

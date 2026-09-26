#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs25-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS25_PROJECT_ID:-$RUN_ID}"
OTHER_PROJECT="${VS25_OTHER_PROJECT:-$RUN_ID-other}"
TMP_PREFIX="/tmp/etlayer-vs25-$$"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -f "$TMP_PREFIX".*
}

trap cleanup EXIT

generate_key() {
  openssl rand -hex 32
}

put_secret() {
  local name="$1"
  local value="$2"

  (
    cd "$INGEST_DIR"
    printf '%s' "$value" |
      npx wrangler secret put "$name" --env "$WRANGLER_ENV" >/dev/null
  )
}

request_json() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local output="$5"

  curl --silent --show-error \
    -o "$output" \
    -w '%{http_code}' \
    -X "$method" "$INGEST_URL$path" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    --data "$body"
}

request_no_body() {
  local method="$1"
  local path="$2"
  local token="$3"
  local output="$4"

  curl --silent --show-error \
    -o "$output" \
    -w '%{http_code}' \
    -X "$method" "$INGEST_URL$path" \
    -H "authorization: Bearer $token"
}

request_json_after_deploy() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local output="$5"
  local status=""

  for attempt in $(seq 1 20); do
    status="$(
      request_json \
        "$method" \
        "$path" \
        "$token" \
        "$body" \
        "$output"
    )"

    if [ "$status" != "401" ]; then
      printf '%s' "$status"
      return 0
    fi

    if [ "$attempt" -lt 20 ]; then
      sleep 1
    fi
  done

  printf '%s' "$status"
}

json_field() {
  local file="$1"
  local path="$2"

  node -e '
    const value = JSON.parse(
      require("fs").readFileSync(
        process.argv[1],
        "utf8",
      ),
    );
    const path =
      process.argv[2].split(".");
    let current = value;

    for (const key of path) {
      current = current?.[key];
    }

    if (current == null) {
      process.exit(1);
    }

    process.stdout.write(
      typeof current === "object"
        ? JSON.stringify(current)
        : String(current),
    );
  ' "$file" "$path"
}

create_project() {
  local project_id="$1"
  local output="$2"
  local after_deploy="$3"
  local status=""

  local body
  body="$(
    node -e '
      process.stdout.write(
        JSON.stringify({
          id: process.argv[1],
        }),
      );
    ' "$project_id"
  )"

  if [ "$after_deploy" = "yes" ]; then
    status="$(
      request_json_after_deploy \
        POST \
        "/_mgmt/projects" \
        "$MANAGEMENT_KEY" \
        "$body" \
        "$output"
    )"
  else
    status="$(
      request_json \
        POST \
        "/_mgmt/projects" \
        "$MANAGEMENT_KEY" \
        "$body" \
        "$output"
    )"
  fi

  [ "$status" = "201" ] ||
    die "Project create failed for $project_id: HTTP $status"
}

cd "$ROOT_DIR"

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] &&
   [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  say "Using non-interactive Cloudflare API token"
else
  npx wrangler whoami >/dev/null 2>&1 ||
    die "Wrangler is not authenticated"
fi

MANAGEMENT_KEY="$(generate_key)"

say "Rotating VS25 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current VS25 Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating isolated project"
create_project   "$PROJECT_ID"   "$TMP_PREFIX.project"   yes

OPERATOR_KEY="$(
  json_field     "$TMP_PREFIX.project"     operatorCredential
)" || die "Operator credential missing."

say "Reading supported project surface before onboarding"
STATUS="$(
  request_no_body     GET     "/api/v1/projects/$PROJECT_ID"     "$OPERATOR_KEY"     "$TMP_PREFIX.before"
)"
[ "$STATUS" = "200" ] ||
  die "Initial project read failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const projectId = process.argv[2];
  const serialized = JSON.stringify(value);

  const ok =
    value.apiVersion === "v1" &&
    value.project?.id === projectId &&
    value.project?.status === "active" &&
    value.project?.source === "registry" &&
    Array.isArray(value.destinations) &&
    value.destinations.length === 0 &&
    value.governance?.ownership?.resources === 0 &&
    value.governance?.lifecycle?.total === 0 &&
    value.links?.self?.endsWith(
      "/api/v1/projects/" + projectId,
    ) &&
    value.links?.onboarding?.endsWith(
      "/api/v1/projects/" +
        projectId +
        "/onboarding",
    ) &&
    value.links?.eventStatusTemplate?.endsWith(
      "/api/v1/projects/" +
        projectId +
        "/events/{eventId}",
    ) &&
    value.links?.ingest?.endsWith("/v1/logs") &&
    !serialized.includes("operatorFingerprint") &&
    !serialized.includes("credentialFingerprint") &&
    !serialized.includes("secretEnv") &&
    !serialized.includes("/_mgmt/") &&
    !serialized.includes("/_ops/");

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.before" "$PROJECT_ID" ||
  die "Initial supported project surface is incorrect."

say "Onboarding one producer and PostHog destination through public API"
STATUS="$(
  curl --silent --show-error \
    -o "$TMP_PREFIX.onboarding" \
    -w '%{http_code}' \
    -X POST \
    "$INGEST_URL/api/v1/projects/$PROJECT_ID/onboarding" \
    -H "authorization: Bearer $OPERATOR_KEY" \
    -H "content-type: application/json" \
    -H "idempotency-key: vs25-$RUN_ID" \
    --data '{"producerId":"backend-main","destinations":["posthog"]}'
)"
[ "$STATUS" = "201" ] ||
  die "Public onboarding failed: HTTP $STATUS"

say "Configuring current contract ownership"
STATUS="$(
  request_json \
    PUT \
    "/_mgmt/projects/$PROJECT_ID/contracts/account.created/ownership" \
    "$OPERATOR_KEY" \
    '{
      "team":"accounts-platform",
      "domain":"accounts",
      "contacts":[
        {"kind":"email","value":"accounts@example.com"}
      ]
    }' \
    "$TMP_PREFIX.ownership"
)"
[ "$STATUS" = "200" ] ||
  die "Ownership configuration failed: HTTP $STATUS"

RANGE_FROM="$(
  node -e '
    process.stdout.write(
      new Date(
        Date.now() - 120000,
      ).toISOString(),
    );
  '
)"
RANGE_TO="$(
  node -e '
    process.stdout.write(
      new Date(
        Date.now() + 120000,
      ).toISOString(),
    );
  '
)"

MANIFEST="$(
  node -e '
    const [
      projectId,
      from,
      to,
    ] = process.argv.slice(1);

    process.stdout.write(
      JSON.stringify({
        apiVersion: "etlayer.dev/v1",
        kind: "ProjectGovernance",
        projectId,
        contracts: [{
          eventName: "account.created",
          currentVersion: 1,
          compatibilityMode:
            "backward",
          proposedContract: {
            id: "account.created@2",
            eventName:
              "account.created",
            version: 2,
            required: {
              "actor.anonymous.id": {
                type: "string"
              },
              "account.id": {
                type: "string"
              },
              "correlation.id": {
                type: "string"
              },
              "causation.id": {
                type: "string"
              },
              "plan.id": {
                type: "string"
              },
              "etlayer.producer.kind": {
                type: "string",
                const: "backend"
              },
              "etlayer.authority.kind": {
                type: "string",
                const:
                  "business_state"
              }
            },
            forbidden: [
              "experiment.id",
              "experiment.variant"
            ]
          },
          from,
          to,
          maxEvents: 10,
          maxExamples: 5
        }]
      }),
    );
  ' "$PROJECT_ID" "$RANGE_FROM" "$RANGE_TO"
)"

say "Planning and publishing one project contract"
STATUS="$(
  request_json \
    POST \
    "/_ops/plan/governance" \
    "$OPERATOR_KEY" \
    "$MANIFEST" \
    "$TMP_PREFIX.plan"
)"
[ "$STATUS" = "200" ] ||
  die "Governance plan failed: HTTP $STATUS"

MANIFEST_DIGEST="$(
  json_field     "$TMP_PREFIX.plan"     manifestDigest
)" || die "Manifest digest missing."

STATUS="$(
  request_json \
    POST \
    "/_mgmt/projects/$PROJECT_ID/governance/publish" \
    "$OPERATOR_KEY" \
    "$(node -e '
      const [
        manifest,
        digest,
      ] = process.argv.slice(1);

      process.stdout.write(
        JSON.stringify({
          manifest:
            JSON.parse(manifest),
          manifestDigest: digest,
          acknowledgeBreaking: true,
        }),
      );
    ' "$MANIFEST" "$MANIFEST_DIGEST")" \
    "$TMP_PREFIX.publish"
)"
[ "$STATUS" = "201" ] ||
  die "Governance publication failed: HTTP $STATUS"

say "Deprecating published contract"
STATUS="$(
  request_json \
    POST \
    "/_mgmt/projects/$PROJECT_ID/contracts/account.created/2/deprecate" \
    "$OPERATOR_KEY" \
    '{}' \
    "$TMP_PREFIX.deprecate"
)"
[ "$STATUS" = "200" ] ||
  die "Contract deprecation failed: HTTP $STATUS"

say "Reading supported project surface after current-state changes"
STATUS="$(
  request_no_body     GET     "/api/v1/projects/$PROJECT_ID"     "$OPERATOR_KEY"     "$TMP_PREFIX.after-1"
)"
[ "$STATUS" = "200" ] ||
  die "Updated project read failed: HTTP $STATUS"

STATUS="$(
  request_no_body     GET     "/api/v1/projects/$PROJECT_ID"     "$OPERATOR_KEY"     "$TMP_PREFIX.after-2"
)"
[ "$STATUS" = "200" ] ||
  die "Repeated project read failed: HTTP $STATUS"

cmp -s   "$TMP_PREFIX.after-1"   "$TMP_PREFIX.after-2" ||
  die "Project read is not deterministic for unchanged current state."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const serialized = JSON.stringify(value);

  const ok =
    JSON.stringify(value.destinations) ===
      JSON.stringify(["posthog"]) &&
    value.governance?.ownership?.resources === 1 &&
    value.governance?.ownership?.teamCount === 1 &&
    value.governance?.ownership?.teams?.[0] ===
      "accounts-platform" &&
    value.governance?.lifecycle?.total === 1 &&
    value.governance?.lifecycle?.published === 0 &&
    value.governance?.lifecycle?.deprecated === 1 &&
    value.governance?.lifecycle?.retired === 0 &&
    !serialized.includes("accounts@example.com") &&
    !serialized.includes("operatorFingerprint") &&
    !serialized.includes("credentialFingerprint") &&
    !serialized.includes("/_mgmt/") &&
    !serialized.includes("/_ops/");

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.after-1" ||
  die "Updated supported project surface is incorrect."

say "Proving cross-project authorization"
create_project   "$OTHER_PROJECT"   "$TMP_PREFIX.other-project"   no

OTHER_OPERATOR="$(
  json_field     "$TMP_PREFIX.other-project"     operatorCredential
)" || die "Other operator credential missing."

STATUS="$(
  request_no_body     GET     "/api/v1/projects/$PROJECT_ID"     "$OTHER_OPERATOR"     "$TMP_PREFIX.cross-project"
)"
[ "$STATUS" = "401" ] ||
  die "Cross-project project read was not denied: HTTP $STATUS"

say "Proving unknown project has stable public 404"
STATUS="$(
  request_no_body     GET     "/api/v1/projects/$RUN_ID-missing"     "$OPERATOR_KEY"     "$TMP_PREFIX.missing"
)"
[ "$STATUS" = "404" ] ||
  die "Unknown project did not return 404: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.error?.code !==
      "project_not_found"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.missing" ||
  die "Unknown-project error contract is incorrect."

unset OPERATOR_KEY
unset OTHER_OPERATOR
unset MANAGEMENT_KEY

say "VS25 supported project read acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "manifestDigest": "$MANIFEST_DIGEST",
  "destinations": ["posthog"],
  "ownershipResources": 1,
  "ownershipTeam": "accounts-platform",
  "deprecatedContracts": 1,
  "publicLinksOnly": true,
  "secretFieldsExposed": false,
  "deterministicRead": true,
  "crossProjectIsolation": true,
  "unknownProjectStable404": true
}
EOF

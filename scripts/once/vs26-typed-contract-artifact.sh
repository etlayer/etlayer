#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs26-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS26_PROJECT_ID:-$RUN_ID}"
OTHER_PROJECT="${VS26_OTHER_PROJECT:-$RUN_ID-other}"
TMP_PREFIX="/tmp/etlayer-vs26-$$"

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

    sleep 1
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
    let current = value;
    for (const key of process.argv[2].split(".")) {
      current = current?.[key];
    }
    if (current == null) process.exit(1);
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

  local status
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

say "Rotating VS26 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current VS26 Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating isolated project"
create_project   "$PROJECT_ID"   "$TMP_PREFIX.project"   yes

OPERATOR_KEY="$(
  json_field     "$TMP_PREFIX.project"     operatorCredential
)" || die "Operator credential missing."

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
                const: "business_state"
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

say "Planning and publishing account.created@2"
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

say "Deprecating published v2 contract"
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

say "Reading project-published contract artifact"
STATUS="$(
  request_no_body \
    GET \
    "/api/v1/projects/$PROJECT_ID/contracts/account.created/2" \
    "$OPERATOR_KEY" \
    "$TMP_PREFIX.v2-artifact"
)"
[ "$STATUS" = "200" ] ||
  die "Published contract artifact failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const serialized = JSON.stringify(value);

  const ok =
    value.apiVersion === "v1" &&
    value.kind === "Contract" &&
    value.projectId === process.argv[2] &&
    value.source === "project" &&
    value.contract?.id ===
      "account.created@2" &&
    value.contract?.version === 2 &&
    value.lifecycle?.status ===
      "deprecated" &&
    value.lifecycle?.manifestDigest ===
      process.argv[3] &&
    !serialized.includes("/_mgmt/") &&
    !serialized.includes("/_ops/") &&
    !serialized.includes("registry/governance/") &&
    !serialized.includes("credential") &&
    !serialized.includes("secret");

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' \
  "$TMP_PREFIX.v2-artifact" \
  "$PROJECT_ID" \
  "$MANIFEST_DIGEST" ||
  die "Published contract artifact is incorrect."

say "Reading built-in v1 contract artifact"
STATUS="$(
  request_no_body \
    GET \
    "/api/v1/projects/$PROJECT_ID/contracts/account.created/1" \
    "$OPERATOR_KEY" \
    "$TMP_PREFIX.v1-artifact"
)"
[ "$STATUS" = "200" ] ||
  die "Built-in contract artifact failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.source === "builtin" &&
    value.contract?.id ===
      "account.created@1" &&
    value.contract?.version === 1 &&
    value.lifecycle == null;

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.v1-artifact" ||
  die "Built-in contract artifact is incorrect."

say "Proving deterministic TypeScript generation"
npm run contract:generate -- \
  --file "$TMP_PREFIX.v2-artifact" \
  --out "$TMP_PREFIX.generated-a.ts" >/dev/null
npm run contract:generate -- \
  --file "$TMP_PREFIX.v2-artifact" \
  --out "$TMP_PREFIX.generated-b.ts" >/dev/null

cmp -s \
  "$TMP_PREFIX.generated-a.ts" \
  "$TMP_PREFIX.generated-b.ts" ||
  die "TypeScript generation is not byte-deterministic."

if grep -Eq   'cloudflare-ingest|\.\./src/|/_mgmt|/_ops'   "$TMP_PREFIX.generated-a.ts"; then
  die "Generated TypeScript depends on ETLayer internals."
fi

cp   "$TMP_PREFIX.generated-a.ts" \
  "$TMP_PREFIX.generated-run.ts"

cat >> "$TMP_PREFIX.generated-run.ts" <<'NODE'

const valid = validateAccountCreatedV2Attributes({
  "actor.anonymous.id": "anon-1",
  "account.id": "account-1",
  "correlation.id": "corr-1",
  "causation.id": "cause-1",
  "plan.id": "pro",
  "etlayer.producer.kind": "backend",
  "etlayer.authority.kind": "business_state",
});

const invalid = validateAccountCreatedV2Attributes({
  "actor.anonymous.id": "anon-1",
  "account.id": "account-1",
  "correlation.id": "corr-1",
  "causation.id": "cause-1",
  "plan.id": "pro",
  "etlayer.producer.kind": "backend",
  "etlayer.authority.kind": "business_state",
  "experiment.id": "exp-1",
});

if (!valid || invalid) {
  process.exit(9);
}
NODE

node --experimental-strip-types \
  "$TMP_PREFIX.generated-run.ts" ||
  die "Generated TypeScript validator did not execute correctly."

say "Proving project isolation and stable contract 404"
create_project   "$OTHER_PROJECT"   "$TMP_PREFIX.other-project"   no

OTHER_OPERATOR="$(
  json_field     "$TMP_PREFIX.other-project"     operatorCredential
)" || die "Other operator credential missing."

STATUS="$(
  request_no_body \
    GET \
    "/api/v1/projects/$PROJECT_ID/contracts/account.created/2" \
    "$OTHER_OPERATOR" \
    "$TMP_PREFIX.cross-project"
)"
[ "$STATUS" = "401" ] ||
  die "Cross-project contract artifact read was not denied: HTTP $STATUS"

STATUS="$(
  request_no_body \
    GET \
    "/api/v1/projects/$PROJECT_ID/contracts/missing.event/9" \
    "$OPERATOR_KEY" \
    "$TMP_PREFIX.missing"
)"
[ "$STATUS" = "404" ] ||
  die "Missing contract did not return 404: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.error?.code !==
      "contract_not_found"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.missing" ||
  die "Missing-contract error contract is incorrect."

unset OPERATOR_KEY
unset OTHER_OPERATOR
unset MANAGEMENT_KEY

say "VS26 typed contract artifact acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "manifestDigest": "$MANIFEST_DIGEST",
  "projectContractSource": "project",
  "projectContractStatus": "deprecated",
  "builtinContractSource": "builtin",
  "generatedTypeScriptDeterministic": true,
  "generatedValidatorExecuted": true,
  "generatedImplementationImports": false,
  "secretFieldsExposed": false,
  "crossProjectIsolation": true,
  "unknownContractStable404": true
}
EOF

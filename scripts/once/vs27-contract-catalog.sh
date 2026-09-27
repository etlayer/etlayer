#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.web33.workers.dev}"
RUN_ID="${RUN_ID:-vs27-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS27_PROJECT_ID:-$RUN_ID}"
OTHER_PROJECT="${VS27_OTHER_PROJECT:-$RUN_ID-other}"
TMP_PREFIX="/tmp/etlayer-vs27-$$"

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

catalog_artifact_path() {
  local file="$1"
  local event_name="$2"
  local version="$3"

  node -e '
    const fs = require("fs");
    const [path, eventName, version] =
      process.argv.slice(1);
    const value = JSON.parse(
      fs.readFileSync(path, "utf8"),
    );
    const item = value.contracts?.find(
      (contract) =>
        contract.eventName === eventName &&
        contract.version === Number(version),
    );
    if (typeof item?.links?.self !== "string") {
      process.exit(1);
    }
    process.stdout.write(
      new URL(item.links.self).pathname,
    );
  ' "$file" "$event_name" "$version"
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

say "Rotating VS27 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current VS27 Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating isolated project"
create_project \
  "$PROJECT_ID" \
  "$TMP_PREFIX.project" \
  yes

OPERATOR_KEY="$(
  json_field \
    "$TMP_PREFIX.project" \
    operatorCredential
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
  json_field \
    "$TMP_PREFIX.plan" \
    manifestDigest
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

say "Reading supported contract catalog twice"
STATUS="$(
  request_no_body \
    GET \
    "/api/v1/projects/$PROJECT_ID/contracts" \
    "$OPERATOR_KEY" \
    "$TMP_PREFIX.catalog-a"
)"
[ "$STATUS" = "200" ] ||
  die "Contract catalog failed: HTTP $STATUS"

STATUS="$(
  request_no_body \
    GET \
    "/api/v1/projects/$PROJECT_ID/contracts" \
    "$OPERATOR_KEY" \
    "$TMP_PREFIX.catalog-b"
)"
[ "$STATUS" = "200" ] ||
  die "Repeated contract catalog failed: HTTP $STATUS"

cmp -s \
  "$TMP_PREFIX.catalog-a" \
  "$TMP_PREFIX.catalog-b" ||
  die "Contract catalog is not byte-deterministic."

node -e '
  const fs = require("fs");
  const [path, projectId] =
    process.argv.slice(1);
  const value = JSON.parse(
    fs.readFileSync(path, "utf8"),
  );
  const contracts =
    value.contracts || [];
  const serialized =
    JSON.stringify(value);

  const v1 = contracts.find(
    (item) =>
      item.eventName ===
        "account.created" &&
      item.version === 1,
  );
  const v2 = contracts.find(
    (item) =>
      item.eventName ===
        "account.created" &&
      item.version === 2,
  );

  const sorted = [...contracts].sort(
    (left, right) => {
      const event =
        left.eventName.localeCompare(
          right.eventName,
        );

      return event !== 0
        ? event
        : left.version -
            right.version;
    },
  );

  const coordinates =
    contracts.map(
      (item) =>
        `${item.eventName}@${item.version}`,
    );

  const ok =
    value.apiVersion === "v1" &&
    value.kind ===
      "ContractCatalog" &&
    value.projectId === projectId &&
    v1?.source === "builtin" &&
    v1?.lifecycle == null &&
    v2?.source === "project" &&
    v2?.lifecycle ===
      "deprecated" &&
    JSON.stringify(contracts) ===
      JSON.stringify(sorted) &&
    new Set(coordinates).size ===
      coordinates.length &&
    !serialized.includes("/_mgmt/") &&
    !serialized.includes("/_ops/") &&
    !serialized.includes("registry/") &&
    !serialized.includes("credential") &&
    !serialized.includes("secret") &&
    !serialized.includes(
      "manifestDigest",
    );

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' \
  "$TMP_PREFIX.catalog-a" \
  "$PROJECT_ID" ||
  die "Contract catalog contents are incorrect."

say "Following exact VS26 artifact links from catalog"
V1_PATH="$(
  catalog_artifact_path \
    "$TMP_PREFIX.catalog-a" \
    account.created \
    1
)" || die "Built-in artifact link missing."

V2_PATH="$(
  catalog_artifact_path \
    "$TMP_PREFIX.catalog-a" \
    account.created \
    2
)" || die "Project artifact link missing."

STATUS="$(
  request_no_body \
    GET \
    "$V1_PATH" \
    "$OPERATOR_KEY" \
    "$TMP_PREFIX.v1-artifact"
)"
[ "$STATUS" = "200" ] ||
  die "Built-in catalog artifact link failed: HTTP $STATUS"

STATUS="$(
  request_no_body \
    GET \
    "$V2_PATH" \
    "$OPERATOR_KEY" \
    "$TMP_PREFIX.v2-artifact"
)"
[ "$STATUS" = "200" ] ||
  die "Project catalog artifact link failed: HTTP $STATUS"

[ "$(
  json_field \
    "$TMP_PREFIX.v1-artifact" \
    source
)" = "builtin" ] ||
  die "Built-in artifact link resolved incorrectly."

[ "$(
  json_field \
    "$TMP_PREFIX.v2-artifact" \
    source
)" = "project" ] ||
  die "Project artifact link resolved incorrectly."

[ "$(
  json_field \
    "$TMP_PREFIX.v2-artifact" \
    lifecycle.status
)" = "deprecated" ] ||
  die "Project artifact lifecycle resolved incorrectly."

say "Proving project isolation"
create_project \
  "$OTHER_PROJECT" \
  "$TMP_PREFIX.other-project" \
  no

OTHER_OPERATOR="$(
  json_field \
    "$TMP_PREFIX.other-project" \
    operatorCredential
)" || die "Other operator credential missing."

STATUS="$(
  request_no_body \
    GET \
    "/api/v1/projects/$PROJECT_ID/contracts" \
    "$OTHER_OPERATOR" \
    "$TMP_PREFIX.cross-project"
)"
[ "$STATUS" = "401" ] ||
  die "Cross-project catalog read was not denied: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.error?.code !==
      "invalid_operator_credential"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.cross-project" ||
  die "Cross-project catalog error contract is incorrect."

unset OPERATOR_KEY
unset OTHER_OPERATOR
unset MANAGEMENT_KEY

say "VS27 supported contract catalog acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "manifestDigest": "$MANIFEST_DIGEST",
  "builtinV1Discoverable": true,
  "projectV2Discoverable": true,
  "projectV2Lifecycle": "deprecated",
  "deterministicOrdering": true,
  "byteStableRead": true,
  "exactArtifactLinksResolve": true,
  "secretFieldsExposed": false,
  "crossProjectIsolation": true
}
EOF

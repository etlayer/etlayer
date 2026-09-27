#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.web33.workers.dev}"
RUN_ID="${RUN_ID:-vs28-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS28_PROJECT_ID:-$RUN_ID}"
TMP_PREFIX="/tmp/etlayer-vs28-$$"
OUT_A="$TMP_PREFIX.generated-a"
OUT_B="$TMP_PREFIX.generated-b"
BAD_OUT="$TMP_PREFIX.bad-output"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -rf "$TMP_PREFIX".*
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

  curl --silent --show-error     -o "$output"     -w '%{http_code}'     -X "$method" "$INGEST_URL$path"     -H "authorization: Bearer $token"     -H "content-type: application/json"     --data "$body"
}

request_no_body() {
  local method="$1"
  local path="$2"
  local token="$3"
  local output="$4"

  curl --silent --show-error     -o "$output"     -w '%{http_code}'     -X "$method" "$INGEST_URL$path"     -H "authorization: Bearer $token"
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
      request_json         "$method"         "$path"         "$token"         "$body"         "$output"
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
  local body
  body="$(
    node -e '
      process.stdout.write(
        JSON.stringify({
          id: process.argv[1],
        }),
      );
    ' "$PROJECT_ID"
  )"

  local status
  status="$(
    request_json_after_deploy       POST       "/_mgmt/projects"       "$MANAGEMENT_KEY"       "$body"       "$TMP_PREFIX.project"
  )"

  [ "$status" = "201" ] ||
    die "Project create failed: HTTP $status"
}

run_generator() {
  local credential="$1"
  local output="$2"

  env -i     PATH="$PATH"     HOME="${HOME:-/tmp}"     ETLAYER_OPERATOR_CREDENTIAL="$credential"     npm run --silent contract:generate:project --       --base-url "$INGEST_URL"       --project-id "$PROJECT_ID"       --out-dir "$output"
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

say "Rotating VS28 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current VS28 Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating isolated project"
create_project

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

say "Publishing project account.created@2"
STATUS="$(
  request_json     POST     "/_ops/plan/governance"     "$OPERATOR_KEY"     "$MANIFEST"     "$TMP_PREFIX.plan"
)"
[ "$STATUS" = "200" ] ||
  die "Governance plan failed: HTTP $STATUS"

MANIFEST_DIGEST="$(
  json_field     "$TMP_PREFIX.plan"     manifestDigest
)" || die "Manifest digest missing."

STATUS="$(
  request_json     POST     "/_mgmt/projects/$PROJECT_ID/governance/publish"     "$OPERATOR_KEY"     "$(node -e '
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
    ' "$MANIFEST" "$MANIFEST_DIGEST")"     "$TMP_PREFIX.publish"
)"
[ "$STATUS" = "201" ] ||
  die "Governance publication failed: HTTP $STATUS"

say "Deprecating project v2 contract"
STATUS="$(
  request_json     POST     "/_mgmt/projects/$PROJECT_ID/contracts/account.created/2/deprecate"     "$OPERATOR_KEY"     '{}'     "$TMP_PREFIX.deprecate"
)"
[ "$STATUS" = "200" ] ||
  die "Contract deprecation failed: HTTP $STATUS"

say "Proving VS27 catalog lifecycle before external pull"
STATUS="$(
  request_no_body     GET     "/api/v1/projects/$PROJECT_ID/contracts"     "$OPERATOR_KEY"     "$TMP_PREFIX.catalog"
)"
[ "$STATUS" = "200" ] ||
  die "Contract catalog failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const v1 = value.contracts?.find(
    (item) =>
      item.eventName ===
        "account.created" &&
      item.version === 1,
  );
  const v2 = value.contracts?.find(
    (item) =>
      item.eventName ===
        "account.created" &&
      item.version === 2,
  );

  if (
    v1?.source !== "builtin" ||
    v2?.source !== "project" ||
    v2?.lifecycle !== "deprecated"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.catalog" ||
  die "Expected effective v1/v2 catalog state is missing."

say "Generating complete project TypeScript from public API only"
run_generator   "$OPERATOR_KEY"   "$OUT_A"   >"$TMP_PREFIX.generator-a"

run_generator   "$OPERATOR_KEY"   "$OUT_B"   >"$TMP_PREFIX.generator-b"

diff -ru   "$OUT_A"   "$OUT_B"   >"$TMP_PREFIX.diff" ||
  die "Repeated project generation is not byte-identical."

MODULE_COUNT="$(
  find "$OUT_A"     -maxdepth 1     -type f     -name '*.ts'     ! -name 'index.ts' |
    wc -l |
    tr -d ' '
)"

[ "$MODULE_COUNT" -ge 2 ] ||
  die "Expected at least built-in v1 and project v2 modules."

V1_FILE="$(
  grep -l     'export const eventName = "account.created"'     "$OUT_A"/*.ts |
    while read -r file; do
      if grep -q         'export const schemaVersion = 1 as const;'         "$file"; then
        printf '%s\n' "$file"
      fi
    done |
    head -n 1
)"

V2_FILE="$(
  grep -l     'export const eventName = "account.created"'     "$OUT_A"/*.ts |
    while read -r file; do
      if grep -q         'export const schemaVersion = 2 as const;'         "$file"; then
        printf '%s\n' "$file"
      fi
    done |
    head -n 1
)"

[ -n "$V1_FILE" ] ||
  die "Generated account.created@1 module missing."
[ -n "$V2_FILE" ] ||
  die "Generated account.created@2 module missing."

grep -q   'export \* as Contract_[a-f0-9]\{64\}_V1'   "$OUT_A/index.ts" ||
  die "Deterministic collision-safe index namespace missing."

if grep -R -E   'packages/cloudflare-ingest|/_mgmt/|/_ops/|registry/|wrangler|CLOUDFLARE_'   "$OUT_A"; then
  die "Generated output leaked ETLayer implementation details."
fi

say "Executing generated project validator"
cat "$V2_FILE" >"$TMP_PREFIX.validator.ts"
cat >>"$TMP_PREFIX.validator.ts" <<'EOF'

const valid = validateAccountCreatedV2Attributes({
  "actor.anonymous.id": "anon-1",
  "account.id": "account-1",
  "correlation.id": "corr-1",
  "causation.id": "cause-1",
  "plan.id": "plan-1",
  "etlayer.producer.kind": "backend",
  "etlayer.authority.kind": "business_state",
});

const invalid = validateAccountCreatedV2Attributes({
  "actor.anonymous.id": "anon-1",
  "account.id": "account-1",
  "correlation.id": "corr-1",
  "causation.id": "cause-1",
  "etlayer.producer.kind": "backend",
  "etlayer.authority.kind": "business_state",
});

if (!valid || invalid) process.exit(7);
EOF

node   --experimental-strip-types   "$TMP_PREFIX.validator.ts" ||
  die "Generated validator did not execute correctly."

say "Proving invalid auth does not publish partial output"
mkdir -p "$BAD_OUT"
printf 'keep\n' >"$BAD_OUT/sentinel.txt"
INVALID_CREDENTIAL="etl_op_invalid_vs28"

if run_generator   "$INVALID_CREDENTIAL"   "$BAD_OUT"   >"$TMP_PREFIX.invalid-out"   2>"$TMP_PREFIX.invalid-err"; then
  die "Invalid operator credential unexpectedly generated output."
fi

[ "$(
  cat "$BAD_OUT/sentinel.txt"
)" = "keep" ] ||
  die "Failed generation replaced existing output."

if find "$BAD_OUT"   -maxdepth 1   -type f   -name '*.ts' |
  grep -q .; then
  die "Failed generation published partial TypeScript output."
fi

if grep -Fq   "$INVALID_CREDENTIAL"   "$TMP_PREFIX.invalid-err"; then
  die "Generator leaked operator credential in error output."
fi

grep -q   'invalid_operator_credential'   "$TMP_PREFIX.invalid-err" ||
  die "Generator did not preserve stable public auth failure code."

say "Running external boundary guard"
node scripts/check-external-consumer-boundary.mjs

unset OPERATOR_KEY
unset MANAGEMENT_KEY

say "VS28 project contract pull + TypeScript generation acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "manifestDigest": "$MANIFEST_DIGEST",
  "projectContractCount": $MODULE_COUNT,
  "builtinV1Generated": true,
  "projectV2Generated": true,
  "projectV2Lifecycle": "deprecated",
  "byteStableGeneration": true,
  "generatedValidatorExecutes": true,
  "invalidAuthNoPartialOutput": true,
  "credentialLeak": false,
  "externalBoundary": true
}
EOF

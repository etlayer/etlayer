#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs15-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS15_PROJECT_ID:-$RUN_ID-a}"
SECOND_PROJECT_ID="${VS15_SECOND_PROJECT_ID:-$RUN_ID-b}"
TMP_PREFIX="/tmp/etlayer-vs15-$$"

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

request() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local name="$5"

  local body_file="$TMP_PREFIX.$name.body"
  local headers_file="$TMP_PREFIX.$name.headers"

  curl --silent --show-error     -D "$headers_file"     -o "$body_file"     -w '%{http_code}'     -X "$method"     "$INGEST_URL$path"     -H "authorization: Bearer $token"     -H "content-type: application/json"     --data "$body"
}

request_after_deploy() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local name="$5"
  local status=""

  for attempt in $(seq 1 20); do
    status="$(
      request         "$method"         "$path"         "$token"         "$body"         "$name"
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

body() {
  cat "$TMP_PREFIX.$1.body"
}

operation_id() {
  awk '
    BEGIN { IGNORECASE = 1 }
    /^x-etlayer-operation-id:/ {
      sub(/^[^:]+:[[:space:]]*/, "");
      gsub(/\r/, "");
      print;
      exit;
    }
  ' "$TMP_PREFIX.$1.headers"
}

json_field() {
  local json="$1"
  local path="$2"

  node -e '
    const value = JSON.parse(process.argv[1]);
    const path = process.argv[2].split(".");
    let current = value;
    for (const key of path) current = current?.[key];
    if (current == null) process.exit(1);
    process.stdout.write(
      typeof current === "object"
        ? JSON.stringify(current)
        : String(current),
    );
  ' "$json" "$path"
}

read_audit() {
  local operation_id="$1"
  local phase="$2"
  local name="$3"
  local key="registry/audit/$operation_id/$phase.json"
  local status

  status="$(
    request       POST       "/_mgmt/evidence"       "$MANAGEMENT_KEY"       "$(node -e '
        process.stdout.write(
          JSON.stringify({ key: process.argv[1] }),
        );
      ' "$key")"       "$name"
  )"

  [ "$status" = "200" ] ||
    die "Audit evidence missing: $key HTTP $status"

  body "$name"
}

assert_audit() {
  local operation_id="$1"
  local action="$2"
  local actor="$3"
  local target_kind="$4"
  local project_id="$5"
  local name="$6"

  local requested
  local applied
  requested="$(read_audit "$operation_id" requested "$name-requested")"
  applied="$(read_audit "$operation_id" applied "$name-applied")"

  node -e '
    const requested = JSON.parse(process.argv[1]);
    const applied = JSON.parse(process.argv[2]);
    const [
      operationId,
      action,
      actor,
      targetKind,
      projectId,
    ] = process.argv.slice(3);

    const ok =
      requested.version === 1 &&
      requested.operationId === operationId &&
      requested.phase === "requested" &&
      requested.action === action &&
      requested.actor?.kind === actor &&
      requested.target?.kind === targetKind &&
      requested.target?.projectId === projectId &&
      typeof requested.recordedAt === "string" &&
      applied.operationId === operationId &&
      applied.phase === "applied" &&
      applied.action === action;

    if (!ok) {
      console.error(JSON.stringify({ requested, applied }, null, 2));
      process.exit(1);
    }
  '     "$requested"     "$applied"     "$operation_id"     "$action"     "$actor"     "$target_kind"     "$project_id" ||
    die "Unexpected audit evidence for $action"

  printf '%s\n%s\n' "$requested" "$applied"
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

say "Rotating VS15 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating audited project"
STATUS="$(
  request_after_deploy     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$PROJECT_ID")"     project
)"
[ "$STATUS" = "201" ] ||
  die "Project create failed: HTTP $STATUS"

PROJECT_OPERATION="$(operation_id project)"
[ -n "$PROJECT_OPERATION" ] ||
  die "Project operation id missing"

PROJECT_BODY="$(body project)"
OPERATOR_KEY="$(json_field "$PROJECT_BODY" operatorCredential)" ||
  die "Operator credential missing"

say "Creating audited producer"
STATUS="$(
  request     POST     "/_mgmt/projects/$PROJECT_ID/producers"     "$OPERATOR_KEY"     '{"id":"backend-main","profileId":"backend"}'     producer
)"
[ "$STATUS" = "201" ] ||
  die "Producer create failed: HTTP $STATUS"

PRODUCER_OPERATION="$(operation_id producer)"
[ -n "$PRODUCER_OPERATION" ] ||
  die "Producer operation id missing"
PRODUCER_BODY="$(body producer)"
PRODUCER_KEY="$(json_field "$PRODUCER_BODY" credential)" ||
  die "Producer credential missing"

say "Enabling audited destination"
STATUS="$(
  request     PUT     "/_mgmt/projects/$PROJECT_ID/destinations/posthog"     "$OPERATOR_KEY"     '{"enabled":true}'     destination
)"
[ "$STATUS" = "200" ] ||
  die "Destination configure failed: HTTP $STATUS"

DESTINATION_OPERATION="$(operation_id destination)"
[ -n "$DESTINATION_OPERATION" ] ||
  die "Destination operation id missing"

say "Rotating audited producer credential"
STATUS="$(
  request     POST     "/_mgmt/projects/$PROJECT_ID/producers/backend-main/rotate"     "$OPERATOR_KEY"     '{}'     rotate
)"
[ "$STATUS" = "200" ] ||
  die "Producer rotate failed: HTTP $STATUS"

ROTATE_OPERATION="$(operation_id rotate)"
[ -n "$ROTATE_OPERATION" ] ||
  die "Rotate operation id missing"
ROTATE_BODY="$(body rotate)"
ROTATED_KEY="$(json_field "$ROTATE_BODY" credential)" ||
  die "Rotated producer credential missing"

say "Disabling audited producer"
STATUS="$(
  request     POST     "/_mgmt/projects/$PROJECT_ID/producers/backend-main/disable"     "$OPERATOR_KEY"     '{}'     disable
)"
[ "$STATUS" = "200" ] ||
  die "Producer disable failed: HTTP $STATUS"

DISABLE_OPERATION="$(operation_id disable)"
[ -n "$DISABLE_OPERATION" ] ||
  die "Disable operation id missing"

say "Reading exact append-only audit evidence"
AUDIT_TEXT=""

AUDIT_TEXT="$AUDIT_TEXT
$(assert_audit "$PROJECT_OPERATION" "project.create" "management" "project" "$PROJECT_ID" project-audit)"
AUDIT_TEXT="$AUDIT_TEXT
$(assert_audit "$PRODUCER_OPERATION" "producer.create" "project_operator" "producer" "$PROJECT_ID" producer-audit)"
AUDIT_TEXT="$AUDIT_TEXT
$(assert_audit "$DESTINATION_OPERATION" "destination.configure" "project_operator" "destination" "$PROJECT_ID" destination-audit)"
AUDIT_TEXT="$AUDIT_TEXT
$(assert_audit "$ROTATE_OPERATION" "producer.rotate" "project_operator" "producer" "$PROJECT_ID" rotate-audit)"
AUDIT_TEXT="$AUDIT_TEXT
$(assert_audit "$DISABLE_OPERATION" "producer.disable" "project_operator" "producer" "$PROJECT_ID" disable-audit)"

say "Proving secret material is absent from audit evidence"
AUDIT_TEXT="$AUDIT_TEXT" MANAGEMENT_KEY_CHECK="$MANAGEMENT_KEY" OPERATOR_KEY_CHECK="$OPERATOR_KEY" PRODUCER_KEY_CHECK="$PRODUCER_KEY" ROTATED_KEY_CHECK="$ROTATED_KEY" node -e '
  const audit = process.env.AUDIT_TEXT || "";
  for (const [name, value] of Object.entries({
    MANAGEMENT_KEY_CHECK: process.env.MANAGEMENT_KEY_CHECK,
    OPERATOR_KEY_CHECK: process.env.OPERATOR_KEY_CHECK,
    PRODUCER_KEY_CHECK: process.env.PRODUCER_KEY_CHECK,
    ROTATED_KEY_CHECK: process.env.ROTATED_KEY_CHECK,
  })) {
    if (value && audit.includes(value)) {
      console.error("Audit evidence leaked " + name);
      process.exit(1);
    }
  }
'

say "Creating second project for unauthorized mutation proof"
STATUS="$(
  request     POST     "/_mgmt/projects"     "$MANAGEMENT_KEY"     "$(node -e '
      process.stdout.write(
        JSON.stringify({ id: process.argv[1] }),
      );
    ' "$SECOND_PROJECT_ID")"     second-project
)"
[ "$STATUS" = "201" ] ||
  die "Second project create failed: HTTP $STATUS"

SECOND_OPERATOR="$(
  json_field "$(body second-project)" operatorCredential
)" || die "Second operator credential missing"

say "Proving unauthorized cross-project mutation has no operation id"
STATUS="$(
  request     PUT     "/_mgmt/projects/$PROJECT_ID/destinations/statsig"     "$SECOND_OPERATOR"     '{"enabled":true}'     unauthorized
)"
[ "$STATUS" = "401" ] ||
  die "Unauthorized mutation was not rejected: HTTP $STATUS"

[ -z "$(operation_id unauthorized)" ] ||
  die "Unauthorized mutation unexpectedly exposed an audit operation id"

unset SECOND_OPERATOR
unset ROTATED_KEY
unset PRODUCER_KEY
unset OPERATOR_KEY
unset MANAGEMENT_KEY

say "VS15 control-plane audit acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "projectOperationId": "$PROJECT_OPERATION",
  "producerOperationId": "$PRODUCER_OPERATION",
  "destinationOperationId": "$DESTINATION_OPERATION",
  "rotateOperationId": "$ROTATE_OPERATION",
  "disableOperationId": "$DISABLE_OPERATION",
  "auditPhases": ["requested", "applied"],
  "secretMaterialAbsent": true,
  "unauthorizedMutationStatus": 401,
  "unauthorizedOperationId": null
}
EOF

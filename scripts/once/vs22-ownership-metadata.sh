#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INGEST_DIR="$ROOT_DIR/packages/cloudflare-ingest"
WRANGLER_ENV="${ETLAYER_WRANGLER_ENV:-ci}"
INGEST_URL="${ETLAYER_INGEST_URL:-https://etlayer-ingest-ci.sergii-ponomarov.workers.dev}"
RUN_ID="${RUN_ID:-vs22-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)}"
PROJECT_ID="${VS22_PROJECT_ID:-$RUN_ID}"
TMP_PREFIX="/tmp/etlayer-vs22-$$"

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

uuid() {
  python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
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

request_json_with_headers() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  local output="$5"
  local headers="$6"

  curl --silent --show-error \
    -D "$headers" \
    -o "$output" \
    -w '%{http_code}' \
    -X "$method" "$INGEST_URL$path" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    --data "$body"
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

operation_id() {
  local headers="$1"

  awk '
    BEGIN { IGNORECASE = 1 }
    /^x-etlayer-operation-id:/ {
      sub(/^[^:]+:[[:space:]]*/, "");
      gsub(/\r/, "");
      print;
      exit;
    }
  ' "$headers"
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

emit_event() {
  local event_id="$1"

  node --input-type=module - \
    "$INGEST_URL/v1/logs" \
    "$PRODUCER_CREDENTIAL" \
    "$event_id" \
    "$RUN_ID" <<'NODE'
const [
  endpoint,
  credential,
  eventId,
  correlationId,
] = process.argv.slice(2);

const now =
  (BigInt(Date.now()) * 1_000_000n).toString();

const stringAttribute = (key, value) => ({
  key,
  value: { stringValue: value },
});

const intAttribute = (key, value) => ({
  key,
  value: { intValue: String(value) },
});

const payload = {
  resourceLogs: [{
    resource: {
      attributes: [
        stringAttribute(
          "service.name",
          "etlayer-vs22-acceptance",
        ),
      ],
    },
    scopeLogs: [{
      scope: {
        name: "etlayer.vs22",
        version: "1",
      },
      logRecords: [{
        eventName: "account.created",
        timeUnixNano: now,
        observedTimeUnixNano: now,
        attributes: [
          stringAttribute(
            "etlayer.event.id",
            eventId,
          ),
          intAttribute(
            "etlayer.schema.version",
            1,
          ),
          stringAttribute(
            "actor.anonymous.id",
            "anon_vs22",
          ),
          stringAttribute(
            "account.id",
            "account_" + eventId,
          ),
          stringAttribute(
            "correlation.id",
            correlationId,
          ),
          stringAttribute(
            "causation.id",
            "vs22-root",
          ),
          stringAttribute(
            "etlayer.producer.kind",
            "backend",
          ),
          stringAttribute(
            "etlayer.authority.kind",
            "business_state",
          ),
        ],
      }],
    }],
  }],
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    authorization:
      "Bearer " + credential,
    "content-type":
      "application/json",
  },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  throw new Error(
    "OTLP ingest failed: HTTP " +
      response.status +
      " " +
      await response.text(),
  );
}
NODE
}

inspect_event() {
  local event_id="$1"
  local output="$2"

  request_json \
    POST \
    "/_ops/inspect" \
    "$OPERATOR_KEY" \
    "$(node -e '
      const [projectId, eventId] =
        process.argv.slice(1);
      process.stdout.write(
        JSON.stringify({
          projectId,
          eventId,
        }),
      );
    ' "$PROJECT_ID" "$event_id")" \
    "$output"
}

wait_complete() {
  local event_id="$1"
  local output="$2"

  for attempt in $(seq 1 45); do
    local status
    status="$(
      inspect_event \
        "$event_id" \
        "$output" || true
    )"

    if [ "$status" = "200" ] &&
      node -e '
        const value = JSON.parse(
          require("fs").readFileSync(
            process.argv[1],
            "utf8",
          ),
        );

        process.exit(
          value?.status === "complete"
            ? 0
            : 1,
        );
      ' "$output"; then
      return 0
    fi

    sleep 1
  done

  cat "$output" >&2 || true
  die "Event did not reach complete: $event_id"
}

read_audit() {
  local operation="$1"
  local phase="$2"
  local output="$3"

  local key="registry/audit/$operation/$phase.json"
  local status

  status="$(
    request_json \
      POST \
      "/_mgmt/evidence" \
      "$MANAGEMENT_KEY" \
      "$(node -e '
        process.stdout.write(
          JSON.stringify({
            key: process.argv[1],
          }),
        );
      ' "$key")" \
      "$output"
  )"

  [ "$status" = "200" ] ||
    die "Audit evidence missing: $key HTTP $status"
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

say "Rotating VS22 management credential"
put_secret ETLAYER_MANAGEMENT_KEY "$MANAGEMENT_KEY"

say "Deploying current VS22 Worker"
(
  cd "$INGEST_DIR"
  npx wrangler deploy --env "$WRANGLER_ENV"
)

say "Creating isolated project"
STATUS="$(
  request_json_after_deploy \
    POST \
    "/_mgmt/projects" \
    "$MANAGEMENT_KEY" \
    "$(node -e '
      process.stdout.write(
        JSON.stringify({
          id: process.argv[1],
        }),
      );
    ' "$PROJECT_ID")" \
    "$TMP_PREFIX.project"
)"
[ "$STATUS" = "201" ] ||
  die "Project create failed: HTTP $STATUS"

OPERATOR_KEY="$(
  json_field \
    "$TMP_PREFIX.project" \
    operatorCredential
)" || die "Operator credential missing."

say "Creating backend producer"
STATUS="$(
  request_json \
    POST \
    "/_mgmt/projects/$PROJECT_ID/producers" \
    "$OPERATOR_KEY" \
    '{"id":"backend-main","profileId":"backend"}' \
    "$TMP_PREFIX.producer"
)"
[ "$STATUS" = "201" ] ||
  die "Producer create failed: HTTP $STATUS"

PRODUCER_CREDENTIAL="$(
  json_field \
    "$TMP_PREFIX.producer" \
    credential
)" || die "Producer credential missing."

EVENT_ID="$(uuid)"

say "Emitting baseline event before ownership exists"
emit_event "$EVENT_ID"
wait_complete \
  "$EVENT_ID" \
  "$TMP_PREFIX.before"

DECISION_ID="$(
  json_field \
    "$TMP_PREFIX.before" \
    decision.decisionId
)" || die "Decision id missing."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.validation?.status === "valid" &&
    value.decision?.outcome === "allow" &&
    value.ownership == null;

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.before" ||
  die "Baseline ownership state is incorrect."

OWNERSHIP='{
  "team":"accounts-platform",
  "domain":"accounts",
  "contacts":[
    {"kind":"slack","value":"#accounts-alerts"},
    {"kind":"email","value":"Accounts@Example.com"},
    {"kind":"url","value":"https://runbooks.example.com/accounts"}
  ]
}'

say "Configuring first-class contract ownership"
STATUS="$(
  request_json_with_headers \
    PUT \
    "/_mgmt/projects/$PROJECT_ID/contracts/account.created/ownership" \
    "$OPERATOR_KEY" \
    "$OWNERSHIP" \
    "$TMP_PREFIX.ownership-put" \
    "$TMP_PREFIX.ownership-put.headers"
)"
[ "$STATUS" = "200" ] ||
  die "Ownership configure failed: HTTP $STATUS"

OWNERSHIP_OPERATION="$(
  operation_id \
    "$TMP_PREFIX.ownership-put.headers"
)"
[ -n "$OWNERSHIP_OPERATION" ] ||
  die "Ownership operation id missing."

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const expected = [
    ["email", "accounts@example.com"],
    ["slack", "#accounts-alerts"],
    ["url", "https://runbooks.example.com/accounts"],
  ];

  const actual =
    (value.ownership?.contacts || [])
      .map(({kind, value}) => [kind, value]);

  const ok =
    value.changed === true &&
    value.ownership?.team ===
      "accounts-platform" &&
    value.ownership?.domain ===
      "accounts" &&
    JSON.stringify(actual) ===
      JSON.stringify(expected);

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.ownership-put" ||
  die "Ownership normalization is incorrect."

say "Proving ownership audit requested and applied"
read_audit \
  "$OWNERSHIP_OPERATION" \
  requested \
  "$TMP_PREFIX.ownership-audit-requested"
read_audit \
  "$OWNERSHIP_OPERATION" \
  applied \
  "$TMP_PREFIX.ownership-audit-applied"

node -e '
  const requested = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  const applied = JSON.parse(
    require("fs").readFileSync(
      process.argv[2],
      "utf8",
    ),
  );

  const serialized =
    JSON.stringify(requested);

  const ok =
    requested.action ===
      "contract.ownership.configure" &&
    requested.actor?.kind ===
      "project_operator" &&
    requested.target?.projectId ===
      process.argv[3] &&
    requested.target?.eventName ===
      "account.created" &&
    requested.change?.contactCount === 3 &&
    applied.phase === "applied" &&
    !serialized.includes(
      "accounts@example.com",
    ) &&
    !serialized.includes(
      "#accounts-alerts",
    );

  if (!ok) {
    console.error(
      JSON.stringify(
        {requested, applied},
        null,
        2,
      ),
    );
    process.exit(1);
  }
' \
  "$TMP_PREFIX.ownership-audit-requested" \
  "$TMP_PREFIX.ownership-audit-applied" \
  "$PROJECT_ID" ||
  die "Ownership audit evidence is incorrect."

say "Reading ownership through management API"
STATUS="$(
  request_no_body \
    GET \
    "/_mgmt/projects/$PROJECT_ID/contracts/account.created/ownership" \
    "$OPERATOR_KEY" \
    "$TMP_PREFIX.ownership-get"
)"
[ "$STATUS" = "200" ] ||
  die "Ownership GET failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  if (
    value.ownership?.team !==
      "accounts-platform" ||
    value.ownership?.domain !==
      "accounts"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.ownership-get" ||
  die "Ownership GET returned unexpected state."

say "Proving historical event now resolves current ownership"
inspect_event \
  "$EVENT_ID" \
  "$TMP_PREFIX.after"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.ownership?.team ===
      "accounts-platform" &&
    value.ownership?.domain ===
      "accounts" &&
    value.decision?.decisionId ===
      process.argv[2];

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.after" "$DECISION_ID" ||
  die "Internal inspection did not expose current ownership."

say "Proving public event status exposes ownership"
STATUS="$(
  request_no_body \
    GET \
    "/api/v1/projects/$PROJECT_ID/events/$EVENT_ID" \
    "$OPERATOR_KEY" \
    "$TMP_PREFIX.public"
)"
[ "$STATUS" = "200" ] ||
  die "Public event status failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.ownership?.team ===
      "accounts-platform" &&
    value.ownership?.contacts?.some(
      (contact) =>
        contact.kind === "email" &&
        contact.value ===
          "accounts@example.com",
    );

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.public" ||
  die "Public event status did not expose ownership."

say "Proving semantically identical ownership is idempotent"
STATUS="$(
  request_json \
    PUT \
    "/_mgmt/projects/$PROJECT_ID/contracts/account.created/ownership" \
    "$OPERATOR_KEY" \
    '{
      "domain":"accounts",
      "team":"accounts-platform",
      "contacts":[
        {"kind":"url","value":"https://runbooks.example.com/accounts"},
        {"kind":"email","value":"accounts@example.com"},
        {"kind":"slack","value":"#accounts-alerts"},
        {"kind":"email","value":"Accounts@Example.com"}
      ]
    }' \
    "$TMP_PREFIX.ownership-repeat"
)"
[ "$STATUS" = "200" ] ||
  die "Idempotent ownership PUT failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  if (value.changed !== false) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.ownership-repeat" ||
  die "Ownership idempotency failed."

say "Changing ownership team"
STATUS="$(
  request_json \
    PUT \
    "/_mgmt/projects/$PROJECT_ID/contracts/account.created/ownership" \
    "$OPERATOR_KEY" \
    '{
      "team":"customer-platform",
      "domain":"accounts",
      "contacts":[
        {"kind":"email","value":"customer-platform@example.com"}
      ]
    }' \
    "$TMP_PREFIX.ownership-change"
)"
[ "$STATUS" = "200" ] ||
  die "Ownership change failed: HTTP $STATUS"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );
  if (
    value.changed !== true ||
    value.ownership?.team !==
      "customer-platform"
  ) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.ownership-change" ||
  die "Ownership team change was not applied."

inspect_event \
  "$EVENT_ID" \
  "$TMP_PREFIX.after-change"

node -e '
  const value = JSON.parse(
    require("fs").readFileSync(
      process.argv[1],
      "utf8",
    ),
  );

  const ok =
    value.ownership?.team ===
      "customer-platform" &&
    value.decision?.decisionId ===
      process.argv[2];

  if (!ok) {
    console.error(
      JSON.stringify(value, null, 2),
    );
    process.exit(1);
  }
' "$TMP_PREFIX.after-change" "$DECISION_ID" ||
  die "Ownership change rewrote decision lineage or was not visible."

say "Proving cross-project ownership isolation"
OTHER_PROJECT="$PROJECT_ID-b"
STATUS="$(
  request_json \
    POST \
    "/_mgmt/projects" \
    "$MANAGEMENT_KEY" \
    "$(node -e '
      process.stdout.write(
        JSON.stringify({
          id: process.argv[1],
        }),
      );
    ' "$OTHER_PROJECT")" \
    "$TMP_PREFIX.other-project"
)"
[ "$STATUS" = "201" ] ||
  die "Second project create failed: HTTP $STATUS"

OTHER_OPERATOR="$(
  json_field \
    "$TMP_PREFIX.other-project" \
    operatorCredential
)" || die "Second operator credential missing."

STATUS="$(
  request_no_body \
    GET \
    "/_mgmt/projects/$PROJECT_ID/contracts/account.created/ownership" \
    "$OTHER_OPERATOR" \
    "$TMP_PREFIX.cross-read"
)"
[ "$STATUS" = "401" ] ||
  die "Cross-project ownership read was not denied: HTTP $STATUS"

STATUS="$(
  request_json \
    PUT \
    "/_mgmt/projects/$PROJECT_ID/contracts/account.created/ownership" \
    "$OTHER_OPERATOR" \
    '{"team":"wrong-team","contacts":[]}' \
    "$TMP_PREFIX.cross-write"
)"
[ "$STATUS" = "401" ] ||
  die "Cross-project ownership write was not denied: HTTP $STATUS"

unset PRODUCER_CREDENTIAL
unset OPERATOR_KEY
unset OTHER_OPERATOR
unset MANAGEMENT_KEY

say "VS22 ownership metadata acceptance passed"
cat <<EOF
{
  "correlationId": "$RUN_ID",
  "projectId": "$PROJECT_ID",
  "eventId": "$EVENT_ID",
  "decisionId": "$DECISION_ID",
  "ownershipOperationId": "$OWNERSHIP_OPERATION",
  "initialTeam": "accounts-platform",
  "updatedTeam": "customer-platform",
  "ownershipVisibleInternally": true,
  "ownershipVisiblePublicly": true,
  "idempotentNormalizedPut": true,
  "historicalDecisionLineageMutated": false,
  "crossProjectIsolation": true
}
EOF

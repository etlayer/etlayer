# Once / acceptance helpers

These scripts reproduce and diagnose ETLayer's Cloudflare vertical slices.

They are intentionally **not** the long-term ETLayer CLI. Keep them while they remain useful as executable acceptance evidence; replace them with durable provisioning or CLI commands when those interfaces stabilize.

Local/manual deployment helpers use the local Wrangler OAuth session unless a helper explicitly documents a non-interactive CI path.

GitHub `Live Acceptance` is different: it runs non-interactively in the dedicated `ci` environment and requires `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`. Destination provider secrets remain Cloudflare Worker secrets and are not stored in GitHub.

## bootstrap-cloudflare.sh

Bootstraps the ETLayer Cloudflare ingest runtime:

1. verifies Node/npm and Wrangler;
2. verifies local Cloudflare authentication;
3. ensures Queue, DLQ, and R2 resources exist;
4. generates and rotates `ETLAYER_INGEST_KEY`;
5. preserves or securely prompts for `POSTHOG_PROJECT_TOKEN`;
6. deploys `etlayer-ingest`;
7. checks `/health`;
8. sends an OTLP smoke event.

```bash
./scripts/once/bootstrap-cloudflare.sh
```

Statsig is intentionally not bootstrapped by this script. VS2 live activation uses a Statsig Server Secret stored only as the Worker secret `STATSIG_SERVER_SECRET`.

## deploy-fixture.sh

Deploys the browser + backend + agent acceptance fixture, configures the trusted browser/backend/agent-runtime ingest credentials, verifies the ETLayer Service Binding, and runs direct plus fixture-mediated OTLP preflights before printing a funnel URL.

```bash
./scripts/once/deploy-fixture.sh
```

## Destination outage switches

Generic form:

```bash
./scripts/once/export-mode.sh posthog disable
./scripts/once/export-mode.sh posthog enable

./scripts/once/export-mode.sh statsig disable
./scripts/once/export-mode.sh statsig enable
```

Compatibility/convenience wrappers:

```bash
./scripts/once/posthog-export-mode.sh disable
./scripts/once/posthog-export-mode.sh enable

./scripts/once/statsig-export-mode.sh disable
./scripts/once/statsig-export-mode.sh enable
```

Disabling one projection does not disable canonical R2 persistence or the other destination.

Do not leave a destination disabled after an acceptance run.

## Destination-aware replay

Generic form:

```bash
./scripts/once/replay-destination.sh \
  --destination statsig \
  --from 2026-09-22T10:00:00Z \
  --to   2026-09-22T10:05:00Z
```

Convenience wrappers preserve the VS1 PostHog command and add the VS2 Statsig equivalent:

```bash
./scripts/once/replay-posthog.sh \
  --from 2026-09-21T20:34:03Z \
  --to   2026-09-21T20:35:05Z

./scripts/once/replay-statsig.sh \
  --from 2026-09-22T10:00:00Z \
  --to   2026-09-22T10:05:00Z
```

Only the named destination is invoked by a replay.

## diagnose-smoke.sh

Low-level diagnostic helper for Queue, R2, Worker logs, and destination projection when the normal smoke path fails.

## Secret handling

These helpers never write secret values into the repository or an `.env` file. Generated ingest/replay keys are passed directly to Wrangler secrets and kept only in process memory.

Runtime destination secrets:

```text
POSTHOG_PROJECT_TOKEN
STATSIG_SERVER_SECRET
```


## VS3 invalid-event contract acceptance

After deploying the current ETLayer Worker and fixture, this helper emits one intentionally invalid versioned business event:

```text
account.created@1
missing: account.id
```

Run:

```bash
./scripts/once/vs3-invalid-account.sh
```

The helper verifies:

- the event was accepted by OTLP ingest;
- the canonical event exists in R2;
- durable validation state is `quarantined`;
- the exact error is `required_attribute_missing/account.id`;
- validation state points back to the exact canonical `sourceKey`;
- PostHog delivery state is absent;
- Statsig delivery state is absent;
- the same canonical object can be revalidated through `/_ops/revalidate` without a producer re-emitting it.

The revalidation operator endpoint is temporarily protected by `ETLAYER_REPLAY_KEY`, the same one-time operator credential used by replay acceptance helpers. A future operator-auth abstraction may replace this shared acceptance credential.


## VS4 privacy acceptance

After deploying the current ETLayer Worker and fixture, this helper emits one valid `account.created@1` with two acceptance-only sensitive attributes:

```text
user.email = acceptance@example.test
auth.token = acceptance-secret-do-not-store
```

Run:

```bash
./scripts/once/vs4-privacy-account.sh
```

The helper verifies:

- `auth.token` was removed before canonical R2 storage;
- the secret literal does not exist in the canonical object;
- `user.email` remains in canonical ETLayer storage;
- contract validation remains `valid`;
- privacy evidence records the ingest secret drop;
- privacy evidence records the delivery direct-identifier drop;
- both PostHog and Statsig delivery states are `exported`.

The destination adapters receive the privacy-sanitized event. Live PostHog verification can additionally confirm that the dropped fields are absent from the stored destination properties.


## VS5 identity continuity acceptance

After deploying the current ETLayer Worker and fixture, this helper proves anonymous-to-user identity continuity without any producer-side PostHog or Statsig identify calls.

Run:

```bash
./scripts/once/vs5-identity-continuity.sh
```

The helper creates an isolated session with:

```text
attribution.source   docs
attribution.medium   acceptance
attribution.campaign vs5
```

It then emits:

```text
landing.hero.exposed
        ↓
identity.linked@1
        ↓
account.created
```

and verifies:

- the anonymous event resolves primary identity to `actor.anonymous.id`;
- `identity.linked@1` resolves primary identity to `user.id`;
- the link records an `anonymous_to_user` transition;
- the subsequent account event keeps the same user/anonymous/session/account coordinates;
- attribution is identical across the three events;
- all three events are contract-valid;
- PostHog delivery state is exported for all three;
- Statsig delivery state is exported for all three.

Independent PostHog verification should additionally confirm that `identity.linked` was projected as `$identify`, with `$anon_distinct_id`, and that pre/post-identification events resolve to the same PostHog person.


## VS5 agent delegation acceptance

After deploying the current ETLayer Worker and fixture, run:

```bash
./scripts/once/vs5-agent-delegation.sh
```

The helper creates one attributed product journey and emits:

```text
anonymous hero
  -> identity.linked
  -> account.created
  -> agent.tool.call
  -> agent.subagent.tool.call
```

It verifies:

- the direct agent event has `subject=user` while `actor.type=agent`;
- the direct delegation is `on_behalf_of -> user`;
- the subagent event has `subject=user` while the immediate actor remains the child agent;
- the subagent delegation chain is ordered as:
  - `delegated_by -> parent agent`
  - `on_behalf_of -> user`;
- both agent events are contract-valid;
- session/account/attribution continuity is preserved;
- PostHog and Statsig delivery state is `exported` for both events.

Independent PostHog verification should additionally confirm that both agent events use the same user `distinct_id` while preserving different `actor.id` properties.


## VS6 trusted provenance and authority acceptance

Deploy the current branch and fixture first:

```bash
./scripts/once/deploy-fixture.sh
```

The deploy helper rotates three independent ingest credentials:

```text
browser       -> interaction
backend       -> business_state
agent-runtime -> agent_runtime
```

Then run:

```bash
./scripts/once/vs6-trusted-authority.sh
```

The helper proves:

- browser interaction claims are allowed under trusted browser provenance;
- backend identity/account facts are allowed under trusted backend provenance;
- agent/subagent facts are allowed under trusted agent-runtime provenance;
- browser credentials cannot forge backend/business-state authority;
- agent-runtime credentials cannot forge backend/business-state authority;
- spoof events are still canonically preserved;
- spoof events remain contract-valid so the proof isolates authority enforcement rather than schema failure;
- durable `authority/<event-id>.json` evidence contains exact block reasons;
- blocked spoof events never reach PostHog or Statsig;
- canonical provenance contains no credential material;
- canonical revalidation remains quarantined without producer re-emission.

The helper rotates the protected revalidation operator secret and redeploys the current ingest Worker before the revalidation assertion.


## VS7 append-only decision lineage acceptance

Deploy the current branch and fixture first:

```bash
./scripts/once/deploy-fixture.sh
```

Then run:

```bash
./scripts/once/vs7-decision-lineage.sh
```

The helper emits one contract-valid browser credential spoof that remains authority-blocked and verifies:

- initial processing creates `decisions/<event-id>/<decision-id>.json`;
- the decision records contract validator, authority policy, and privacy policy versions;
- `decision-latest/<event-id>.json` points at the initial processing decision;
- the blocked event has no PostHog or Statsig delivery state;
- canonical revalidation creates a distinct decision with `evaluationKind=revalidation`;
- the latest pointer advances to the revalidation decision;
- the original decision record remains present and byte-for-byte unchanged;
- revalidation remains contract-valid, authority-blocked, and unrouted.

The helper rotates the protected revalidation operator secret and redeploys the current ingest Worker before the revalidation assertion.


## VS8 project-scoped configuration and isolation acceptance

Run:

```bash
./scripts/once/vs8-project-isolation.sh
```

The helper is self-contained for acceptance credentials. It rotates the default browser/backend credentials, the secondary backend credential, and both project operator credentials, then keeps the default fixture synchronized.

It proves:

- trusted project identity comes from the authenticated credential, not `etlayer.project.id` in the payload;
- the same logical event ID can exist independently in `etlayer-default` and `etlayer-secondary`;
- canonical, validation, authority, privacy, identity, decision, and delivery evidence is physically project-namespaced;
- the default project routes to PostHog + Statsig;
- the secondary project routes to PostHog only;
- default project operator credentials cannot operate on the secondary project;
- project-scoped source keys cannot be smuggled across revalidation boundaries;
- the secondary project cannot replay Statsig.

Existing VS3-VS7 helpers default to `ETLAYER_PROJECT_ID=etlayer-default` after VS8.


## VS14 first-class quarantine acceptance

Run:

~~~bash
./scripts/once/vs14-quarantine.sh
~~~

The helper proves the explicit trust decision model:

~~~text
ALLOW       valid contract + allowed authority -> route
QUARANTINE  recoverable contract failure       -> preserve, do not route
BLOCK       semantic authority failure          -> preserve, do not route
~~~

It creates one isolated dynamic project, provisions a backend producer through the public onboarding contract, and emits three events:

- a valid `account.created@1` that reaches PostHog;
- an `account.created@1` missing `account.id`, which becomes quarantined;
- a contract-valid `landing.hero.exposed@1` sent with the backend credential while claiming browser/interaction authority, which is blocked.

The quarantined event is then revalidated from the immutable preserved source without producer re-emission and remains quarantined.

VS14 reuses the existing R2 evidence and revalidation primitives. It does not create a separate quarantine queue or storage subsystem.

## VS15 control-plane audit acceptance

Run:

~~~bash
./scripts/once/vs15-control-plane-audit.sh
~~~

The helper proves append-only internal management audit evidence around real Cloudflare mutations:

~~~text
requested
  -> mutation
  -> applied
~~~

It verifies project creation, producer creation, destination configuration, producer credential rotation, and producer disable. Each successful management response exposes an `x-etlayer-operation-id`, and the helper reads the exact `requested` and `applied` evidence through the privileged registry evidence path.

The acceptance also proves:

- global management vs project-operator actor attribution;
- project/resource target attribution;
- raw management/operator/producer credentials are absent from audit evidence;
- unauthorized cross-project mutation returns HTTP 401 and exposes no operation ID.

The versioned public onboarding endpoint is intentionally not wrapped by VS15's random operation IDs because its retry contract is already idempotency-key based. Unifying those two operation identities is a follow-up.

## VS16 contract compatibility acceptance

Run:

~~~bash
bash ./scripts/once/vs16-contract-compatibility.sh
~~~

VS16 is a deterministic governance/DX slice and does not require Cloudflare.

The acceptance uses `account.created@1` as the real baseline and proves:

- removing a required field is backward-compatible;
- the same relaxation is forward-breaking and therefore full-breaking;
- adding a required field is backward-breaking;
- tightening `account.id` from string to integer is backward-breaking;
- breaking reasons are machine-readable;
- CLI exit code is `0` for compatible and `2` for breaking.

Direct CLI usage:

~~~bash
npm run contract:check -- \
  --from packages/cloudflare-ingest/contracts/account.created.v1.js \
  --to path/to/account.created.v2.js \
  --mode backward \
  --json
~~~

## VS17 historical contract plan acceptance

Run:

~~~bash
bash ./scripts/once/vs17-contract-plan.sh
~~~

The helper proves that a proposed contract can be evaluated against immutable project history without mutating runtime state.

It creates three `account.created@1` events and proposes `account.created@2` with a new required `plan.id`.

Expected transitions:

~~~text
allow_to_allow                 1
allow_to_quarantine            1
quarantine_to_quarantine       1
~~~

It also proves:

- static backward compatibility is breaking;
- the changed event is identified in bounded examples;
- the event's latest `decisionId` is byte-for-byte the same coordinate before and after planning;
- no destination delivery is triggered by plan;
- the test project has no destinations, so the proof isolates archive analysis from delivery.

## One-time Cloudflare CI bootstrap

VS8 live acceptance has a dedicated Cloudflare environment. It does not deploy branch code to the default ETLayer Workers.

The CI resources are:

```text
Worker: etlayer-ingest-ci
Worker: etlayer-cloudflare-fixture-ci
Queue:  etlayer-events-ci
DLQ:    etlayer-events-ci-dlq
R2:     etlayer-events-archive-ci
R2:     etlayer-fixture-state-ci
```

Bootstrap them once using the local Wrangler OAuth session:

```bash
git switch main
git pull --ff-only
./scripts/once/bootstrap-cloudflare-ci.sh
```

The script will securely prompt for four persistent CI secrets:

```text
ETLayer destination encryption master key v1
ETLayer idempotency encryption master key v1
ETLayer PostHog project token
ETLayer Statsig server secret
```

Generate each encryption master key once with:

```bash
openssl rand -hex 32
```

Keep both v1 master-key values stable and store recovery copies in an appropriate secret manager/password vault. Acceptance scripts must not rotate them. Future key rotation must introduce a new key version and migrate encrypted records deliberately.

All four values are written directly to `etlayer-ingest-ci` as Cloudflare Worker secrets. They are not written to the repository or GitHub Actions.

After bootstrap, use a dedicated GitHub Environment named `ci`:

```text
Environment secret:
  CLOUDFLARE_API_TOKEN

Environment variable:
  CLOUDFLARE_ACCOUNT_ID
```

The Cloudflare token needs:

```text
Specified Workers:
  etlayer-ingest-ci
  etlayer-cloudflare-fixture-ci
  Individual Workers Editor

Entire account:
  Workers Content Read-Only

Entire account:
  Queues Write
```

Direct R2 object permission is not required. The live acceptance reads exact evidence through ETLayer's authenticated `/_ops/evidence` operation, which is restricted to the requesting project's namespace and reads through the Worker's R2 binding.

The token does not need to create Workers, R2 buckets, zones, routes, DNS records, or domains.

Live acceptance runs on same-repository pull requests carrying the `live-acceptance` label. A manual `workflow_dispatch` entry point is also available.


## VS9 dynamic management acceptance

Run:

```bash
./scripts/once/vs9-dynamic-management.sh
```

The helper runs against the selected Wrangler environment (normally `ci`) and:

- rotates an ephemeral `ETLAYER_MANAGEMENT_KEY`;
- creates two unique dynamic projects;
- proves cross-project operator denial;
- enables PostHog dynamically for project A;
- creates a backend producer and receives its credential once;
- proves registry records contain credential fingerprints rather than plaintext credentials;
- sends an allowed dynamic-project event;
- proves PostHog-only routing;
- rotates the producer credential and proves the old credential returns 401;
- proves the rotated credential succeeds;
- disables the producer and proves the current credential returns 401.

The GitHub `Live Acceptance` workflow runs VS8 first and VS9 second so dynamic management changes cannot silently regress the project-isolation proof.


## VS10 first external onboarding acceptance

Run:

```bash
./scripts/once/vs10-first-external-onboarding.sh
```

The helper exercises the product-facing onboarding path instead of constructing internal evidence keys:

- rotates an ephemeral management credential;
- creates two unique dynamic projects;
- provisions project A through `POST /_mgmt/projects/:projectId/onboarding`;
- validates the returned OTLP endpoint, headers, inspect endpoint, and generated Node quickstart;
- proves an unknown event returns `pending_or_unknown`;
- writes the generated quickstart to a temporary `.mjs` file and executes it exactly as returned;
- captures the generated event ID from the quickstart output;
- polls `POST /_ops/inspect` using only `projectId + eventId`;
- waits for complete validation, authority, decision, identity, privacy, and PostHog delivery evidence;
- proves another project operator receives HTTP 401 when attempting to inspect the event.

The GitHub `Live Acceptance` workflow runs VS8, VS9, and VS10 serially so onboarding changes cannot regress project isolation or dynamic credential management.


## VS11 project-scoped destination credential acceptance

Run:

```bash
./scripts/once/vs11-project-destination-credentials.sh
```

The helper proves the destination-secret boundary end-to-end:

- uses the persistent CI `ETLAYER_DESTINATION_SECRET_KEY_V1` provisioned by the one-time bootstrap;
- creates two dynamic projects;
- writes the same known plaintext canary to both projects;
- proves the plaintext literal is absent from exact registry evidence;
- proves the two AES-GCM ciphertexts and IVs differ;
- bootstraps the existing CI PostHog Worker token into each project without returning plaintext;
- proves both projects export with their own encrypted project credential;
- rotates project A's provider credential and proves delivery still succeeds;
- disables project B's provider credential and proves the next valid event is not exported;
- leaves exact event IDs for independent PostHog verification.

Important: the CI `ETLAYER_DESTINATION_SECRET_KEY_V1` is an encryption root, not an acceptance credential. Keep it stable across runs. Do not overwrite any persistent `v1` master key while encrypted records depend on it.


## VS12 external integration contract acceptance

Run:

```bash
bash ./scripts/once/vs12-external-integration-contract.sh
```

The helper performs privileged CI setup first, then hands only the public consumer inputs to `examples/external-consumer/run.mjs`:

```text
ETLAYER_BASE_URL
ETLAYER_PROJECT_ID
ETLAYER_OPERATOR_CREDENTIAL
```

The external consumer is statically checked so it cannot depend on:

```text
/_mgmt/*
/_ops/*
Wrangler
Cloudflare API/account credentials
ETLAYER_MANAGEMENT_KEY
R2/registry paths
packages/cloudflare-ingest imports
```

It then proves:

- `POST /api/v1/projects/:projectId/onboarding`;
- required `Idempotency-Key`;
- same-key/same-request replay returns the same producer credential without duplicate mutation;
- same-key/different-request returns `409 idempotency_key_reused`;
- stable error codes for missing idempotency, malformed JSON, media type, and invalid operator authentication;
- the returned quickstart executes exactly as delivered;
- standard `POST /v1/logs` ingestion remains the event transport;
- `GET /api/v1/projects/:projectId/events/:eventId` reaches `complete`;
- validation, authority, route eligibility, and PostHog delivery are visible through the public status contract;
- public event status does not expose `sourceKey`;
- cross-project public event inspection returns HTTP 401 with `invalid_operator_credential`;
- the durable idempotency replay capsule is AES-256-GCM encrypted and contains no plaintext `etl_prod_` credential.

The live workflow runs VS8 through VS12 serially so the new product boundary cannot weaken the existing isolation/security foundation.

The helper uses the persistent CI `ETLAYER_IDEMPOTENCY_SECRET_KEY_V1` provisioned by the one-time bootstrap. It must remain stable while unexpired replay capsules depend on it. Future rotation should introduce a new key version rather than overwrite `v1`.

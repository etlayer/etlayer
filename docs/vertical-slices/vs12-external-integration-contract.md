# VS12: External Integration Contract

**Status: VS12 complete; final CI, full VS8 -> VS12 Cloudflare acceptance, and independent PostHog verification passed on 2026-09-24.**

Tracks issue #40.

## Purpose

VS1-VS11 completed ETLayer's data-plane foundation.

VS12 starts Phase 2 by proving that ETLayer can be consumed as a product by an application that does not know how ETLayer is implemented.

The test is:

> Can a clean external consumer integrate, emit an event, and determine the result using only documented public endpoints and issued credentials?

## Why this slice now

Before VS11 the primary risk was data-plane correctness:

- preservation;
- contracts;
- privacy;
- authority;
- identity;
- decision lineage;
- project isolation;
- project-scoped routing and credentials.

Those invariants are now live-proven together.

The remaining integration boundary still exposes implementation-era concepts:

~~~text
/_mgmt/...
/_ops/...
~~~

and public failures are mostly human strings.

VS10 also returns a one-shot producer credential. If a client loses the HTTP response after ETLayer committed the mutation, a naive retry is not safely recoverable.

That is the product-contract gap VS12 addresses.

## Scope

VS12 contains four linked pieces:

1. a versioned external API namespace;
2. a stable machine-readable error contract;
3. retry-safe onboarding with explicit idempotency;
4. a clean external-consumer live acceptance boundary.

It deliberately does not build the broader hosted SaaS control plane.

# Boundary model

ETLayer has three different HTTP surfaces after VS12.

## Standard ingest surface

~~~text
POST /v1/logs
~~~

This remains OTLP/HTTP JSON.

It is not moved under /api/v1. ETLayer should not rename a standard OpenTelemetry ingest path merely to make all URLs visually consistent.

## Public ETLayer product API

~~~text
/api/v1/...
~~~

This is the first namespace with an explicit compatibility contract for external integrators.

VS12 exposes only the minimum proven endpoints:

~~~text
POST /api/v1/projects/:projectId/onboarding
GET  /api/v1/projects/:projectId/events/:eventId
~~~

## Internal/operator compatibility surfaces

~~~text
/_mgmt/...
/_ops/...
~~~

These remain available for existing regression acceptance and privileged bootstrap where required.

They are not part of the external compatibility promise.

New external acceptance must not call them.

# Authentication model

VS12 does not introduce users, accounts, organizations, sessions, OAuth, or generalized RBAC.

The public API uses the existing project operator credential:

~~~http
Authorization: Bearer etl_op_...
~~~

The privilege model remains intentionally small:

~~~text
global management credential
    |
    +-- create/bootstrap project
    +-- privileged CI/operator setup
    |
    X never given to external consumer

project operator credential
    |
    +-- public onboarding for that project
    +-- public event status for that project
~~~

Producer credentials remain distinct:

~~~text
etl_prod_...
~~~

They authorize event ingestion, not project-operator API actions.

# Public endpoint 1 - onboarding

## Request

~~~http
POST /api/v1/projects/customer-a/onboarding
Authorization: Bearer <project-operator-credential>
Idempotency-Key: 0199f58f-...
Content-Type: application/json
~~~

Body:

~~~json
{
  "producerId": "backend-main",
  "destinations": ["posthog"]
}
~~~

VS12 intentionally preserves the narrow VS10 onboarding meaning:

- create the canonical backend producer;
- enable the requested supported destinations;
- return a usable OTLP connection bundle;
- return the producer credential in the successful secret-bearing response.

Arbitrary producer profile construction is not part of this slice.

## Success response

Representative shape:

~~~json
{
  "apiVersion": "v1",
  "projectId": "customer-a",
  "producer": {
    "id": "backend-main",
    "projectId": "customer-a",
    "status": "active",
    "profileId": "backend",
    "producerKind": "backend",
    "allowedAuthorityKinds": ["business_state"]
  },
  "credential": "etl_prod_...",
  "destinations": ["posthog"],
  "connection": {
    "protocol": "otlp/http-json",
    "endpoint": "https://example.etlayer.dev/v1/logs",
    "headers": {
      "authorization": "Bearer etl_prod_...",
      "content-type": "application/json"
    }
  },
  "eventStatus": {
    "urlTemplate": "https://example.etlayer.dev/api/v1/projects/customer-a/events/{eventId}"
  },
  "quickstart": {
    "runtime": "node",
    "source": "..."
  }
}
~~~

Exact field naming may be adjusted during implementation, but these semantic elements are required.

## Trusted project invariant

The generated quickstart continues to omit:

~~~text
etlayer.project.id
~~~

The producer credential selects trusted project context.

A public API must not weaken VS8 by encouraging callers to state their own tenant identity inside event payloads.

# Idempotency

## Why it is required

Onboarding performs multiple mutations and returns a secret.

Without idempotency:

~~~text
client sends onboarding
  -> ETLayer creates producer
  -> ETLayer sends response
  -> network loses response
  -> client retries
  -> conflict / duplicate lifecycle ambiguity
~~~

A public automation surface must define what retry means.

Therefore Idempotency-Key is required on the public onboarding endpoint.

## Key rules

The key is:

- client-generated;
- opaque to ETLayer;
- non-empty;
- bounded in length;
- not interpreted as a UUID requirement;
- scoped to project + operation.

The plaintext key must not be stored.

ETLayer stores a SHA-256 fingerprint for lookup.

## Request identity

ETLayer computes a canonical request fingerprint from the semantic request.

At minimum:

~~~text
method
public operation version
projectId
normalized producerId
normalized sorted/deduplicated destinations
~~~

Headers unrelated to semantics are not part of the request fingerprint.

## Same key, same request

The result must be replayable without repeating mutations.

Expected behavior:

~~~text
first request
  -> perform operation once
  -> persist idempotency result
  -> return 201

same key + same request during replay window
  -> perform no mutation
  -> return the same logical response
~~~

Because the successful response contains a producer credential, the replay result must preserve the same credential.

Storing only the producer credential fingerprint is insufficient for a lost-response retry.

## Encrypted replay capsule

VS12 introduces a narrowly scoped encrypted idempotency response capsule.

Recommended internal record:

~~~text
registry/idempotency/<project>/onboarding/<key-fingerprint>.json
~~~

Representative metadata:

~~~json
{
  "version": 1,
  "projectId": "customer-a",
  "operation": "onboarding.v1",
  "keyFingerprint": "...",
  "requestFingerprint": "...",
  "status": 201,
  "keyVersion": "v1",
  "algorithm": "AES-256-GCM",
  "iv": "...",
  "ciphertext": "...",
  "createdAt": "...",
  "replayUntil": "..."
}
~~~

The ciphertext contains only the replayable public response needed to make a network retry safe.

The plaintext producer credential is never written directly to R2.

## Separate encryption domain

Do not reuse ETLAYER_DESTINATION_SECRET_KEY_V1 for idempotency response capsules.

Destination-provider secrets and public-response replay are different security domains.

Use a dedicated versioned key, for example:

~~~text
ETLAYER_IDEMPOTENCY_SECRET_KEY_V1
~~~

with domain-specific AAD containing:

~~~text
format version
projectId
operation
idempotency key fingerprint
request fingerprint
key version
~~~

## Same key, different request

No mutation occurs.

Response:

~~~http
409 Conflict
~~~

~~~json
{
  "error": {
    "code": "idempotency_key_reused",
    "message": "Idempotency key was already used with a different request"
  }
}
~~~

## Expired replay capsule

VS12 must define a bounded replay window.

The exact duration is an implementation choice, but it must be documented and testable.

After the replay window, ETLayer must not silently execute the operation as new under the same key.

Return:

~~~text
409 idempotency_key_expired
~~~

A client can then deliberately use a new key.

This preserves the meaning:

~~~text
same idempotency key == same attempted operation
~~~

# Atomicity and partial failure

VS10 explicitly deferred transactional onboarding rollback.

VS12 does not require a general transaction engine, but retry safety means partial state must become deterministic.

The implementation should structure onboarding so that one of these outcomes is true:

~~~text
A. completed result exists and is replayable

B. operation record says processing/recoverable
   and retry resumes safely

C. operation failed before externally visible mutations
   and retry can execute safely
~~~

A client must never need to inspect registry keys to decide which case occurred.

If the smallest implementation cannot safely resume the existing multi-write path, the slice may introduce a narrow onboarding operation state machine.

Do not solve this with broad workflow infrastructure.

# Stable error contract

## Envelope

All public /api/v1 failures return:

~~~json
{
  "error": {
    "code": "invalid_operator_credential",
    "message": "Invalid operator credential for project"
  }
}
~~~

Rules:

- code is the stable machine-readable contract;
- message is human-readable;
- additional fields may be added compatibly later;
- public clients must not be forced to parse message text.

## Initial codes

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | invalid_request | request shape or values are invalid |
| 400 | idempotency_key_required | required idempotency key is absent/invalid |
| 401 | invalid_operator_credential | operator authentication failed |
| 404 | project_not_found | requested dynamic project is unavailable |
| 409 | onboarding_conflict | requested onboarding conflicts with existing project state |
| 409 | idempotency_key_reused | same key used for different semantic request |
| 409 | idempotency_key_expired | original response is no longer replayable |
| 415 | unsupported_media_type | request is not JSON where JSON is required |
| 503 | service_unavailable | required service/configuration dependency is unavailable |
| 500 | internal_error | unexpected public-safe server failure |

Implementation can introduce more precise v1 codes when they are genuinely useful.

Do not expose internal class names as codes.

## No internal leakage

Public errors must not expose:

- R2 object keys;
- registry path layout;
- ciphertext or IVs;
- encryption keys or key material;
- Worker environment variable names;
- Cloudflare account/resource identifiers;
- raw internal exception stack/message where it contains implementation detail.

# Public endpoint 2 - event status

## Request

~~~http
GET /api/v1/projects/customer-a/events/2dc...f8
Authorization: Bearer <project-operator-credential>
~~~

No request body is required.

Project identity appears in the URL for resource selection but is authorized against the operator credential.

The event ID never authorizes access by itself.

## Response lifecycle

Preserve VS10 lifecycle semantics:

~~~text
pending_or_unknown
processing
complete
~~~

Representative response:

~~~json
{
  "apiVersion": "v1",
  "projectId": "customer-a",
  "eventId": "2dc...f8",
  "status": "complete",
  "validation": {
    "status": "valid"
  },
  "authority": {
    "status": "allowed"
  },
  "privacy": {
    "status": "applied"
  },
  "identity": {
    "status": "resolved"
  },
  "decision": {
    "routeEligible": true
  },
  "deliveries": [
    {
      "destination": "posthog",
      "status": "exported"
    }
  ]
}
~~~

The public response may contain safe semantic details needed for diagnosis.

It must not require or expose the canonical sourceKey.

## Unknown versus pending

Keep pending_or_unknown for VS12.

Distinguishing "does not exist" from "accepted but not processed" would require a stronger event receipt/index contract.

That is not required to prove this slice.

# Compatibility strategy

VS12 should avoid duplicate domain logic.

Conceptually:

~~~text
public /api/v1 handler
      |
      v
stable request/error translation
      |
      v
existing onboarding / inspection domain operations
~~~

Do not implement the public API by making an HTTP request from one Worker route to another internal route.

Refactor shared domain operations if necessary.

Existing paths may remain:

~~~text
/_mgmt/projects/:projectId/onboarding
/_ops/inspect
~~~

during VS12 for regression compatibility.

They do not become aliases that external documentation advertises.

# External-consumer fixture

## Strong boundary

The preferred acceptance shape is a separate repository under the ETLayer organization, for example:

~~~text
etlayer/external-integration-fixture
~~~

The exact repository name is not part of the product contract.

A separate repository makes accidental imports of Worker implementation code structurally difficult.

If repository creation is deferred, an isolated package must enforce equivalent dependency restrictions.

## Inputs

The external consumer receives only:

~~~text
ETLAYER_BASE_URL
ETLAYER_PROJECT_ID
ETLAYER_OPERATOR_CREDENTIAL
~~~

It does not receive:

~~~text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
ETLAYER_MANAGEMENT_KEY
R2 credentials
destination provider secret
Wrangler profile
~~~

## Allowed behavior

The fixture may:

- call documented /api/v1 endpoints;
- execute the returned Node quickstart;
- send OTLP through the returned standard connection metadata;
- poll public event status;
- assert public HTTP status/error codes.

## Forbidden behavior

The fixture must not:

- call /_mgmt/*;
- call /_ops/*;
- call Cloudflare APIs;
- invoke Wrangler;
- inspect R2;
- know registry/evidence key formats;
- import packages/cloudflare-ingest or any implementation module;
- use ETLayer test-only helpers to reconstruct event state.

A static acceptance check should scan the fixture for forbidden internal strings/dependencies.

# Live acceptance sequence

The CI orchestration may perform privileged bootstrap before handing control to the external fixture.

That distinction is important:

~~~text
test harness setup
  may use privileged ETLayer setup

external consumer phase
  may use public product contract only
~~~

## Setup phase

1. deploy current branch to the isolated Cloudflare CI environment;
2. rotate ephemeral test-only management/idempotency keys as appropriate;
3. create project A and project B through privileged bootstrap;
4. configure project A's PostHog destination credential;
5. retain project B for cross-project denial;
6. export only base URL, project IDs, and project operator credentials to the external-consumer phase.

## External phase

7. call public onboarding for project A with idempotency key K1;
8. validate the returned v1 contract;
9. call the same request again with K1;
10. prove the producer is not duplicated and the same credential/logical response is replayed;
11. call a different onboarding request with K1;
12. prove 409 idempotency_key_reused;
13. execute the exact returned quickstart;
14. capture the locally generated event ID;
15. poll only GET /api/v1/projects/:projectId/events/:eventId;
16. reach complete;
17. prove validation is valid;
18. prove authority is allowed;
19. prove route eligibility is true;
20. prove PostHog delivery is exported;
21. use project B operator credential against project A event and prove denial;
22. exercise malformed JSON/media type/auth errors and assert codes rather than messages;
23. run the forbidden-surface/dependency check.

## Independent destination proof

24. after external acceptance, independently verify the exact event in the ETLayer PostHog project;
25. prove trusted etlayer.project.id is project A;
26. prove exactly one projected row for the accepted event.

## Regression

27. run existing VS8 -> VS11 live acceptance serially;
28. VS12 is not complete unless both the existing foundation suite and new external-contract suite are green.

# Test strategy

## Unit tests

Cover:

- public route parsing;
- public error translation;
- idempotency key validation;
- request canonicalization/fingerprinting;
- encrypted replay capsule round trip;
- AAD transplant resistance;
- same key/same request replay;
- same key/different request conflict;
- expired replay behavior;
- no plaintext credential in idempotency storage;
- public event status response excludes internal source key;
- project auth isolation.

## Integration tests

Cover:

- onboarding domain operation is executed once;
- partial/retry state converges safely;
- public handler delegates to shared domain logic rather than separate semantics;
- legacy VS10 internal endpoints remain compatible where intentionally retained.

## Live tests

The live proof is authoritative for the external boundary because it includes:

- real Worker deployment;
- real Queue/R2 processing;
- real encrypted idempotency persistence;
- real PostHog delivery;
- real cross-project auth.

# Observability of the API itself

VS12 should not introduce a full service-observability program, but public API failures need enough safe diagnostics for operators.

At minimum internal logs should be able to correlate:

~~~text
operation
projectId
idempotency key fingerprint
request fingerprint
result/error code
~~~

Never log:

~~~text
operator credential
producer credential
plaintext idempotency key
encrypted response plaintext
destination provider credential
~~~

A future operations slice can standardize request IDs and service-level telemetry.

# Versioning policy for v1

VS12 does not need a universal API governance framework, but it must establish a small rule set.

Within /api/v1, compatible changes may include:

- adding optional response fields;
- adding new error detail fields while preserving error.code;
- adding new endpoints;
- adding optional request fields with safe defaults.

Incompatible changes include:

- removing/renaming documented fields;
- changing field type/meaning;
- changing an existing error code's meaning;
- turning an optional request field into required;
- changing authentication semantics.

An incompatible change requires a new API version or an explicit migration strategy.

The route version is the compatibility boundary, not the internal registry record version.

# Security review

## Secrets

Public onboarding can transiently handle:

- project operator credential in request auth;
- generated producer credential in result;
- encrypted idempotency replay capsule.

Requirements:

- no credential in logs;
- no plaintext credential in R2;
- no secret returned by ordinary status/read endpoints;
- encryption keys remain Worker secrets;
- dedicated idempotency encryption key version.

## Project isolation

The public event endpoint must authenticate project operator against the requested project before reading event state.

Do not return project A event state to project B even when the event ID is known.

# Alternatives considered

## Alias /_mgmt and /_ops as public

Rejected.

Those names communicate privileged/internal semantics and currently expose string-oriented implementation errors.

A compatibility alias does not create a product contract.

## Build a CLI first

Rejected for this slice.

A CLI would hide API weaknesses.

The public HTTP contract must be strong enough that a CLI can later be a thin client.

## Add public signup/accounts first

Rejected.

That expands identity, membership, RBAC, billing, and lifecycle scope before the project API contract is proven.

## Skip idempotent credential replay

Rejected.

If the endpoint returns a one-shot credential, a lost success response is a normal distributed-systems failure mode.

"Retry and rotate manually" is not a stable automation contract.

## Reuse destination secret encryption key

Rejected.

Different secret domains should have independent key lifecycle and compromise boundaries.

# Non-goals

VS12 does not include:

- user signup/login;
- organizations/workspaces/accounts;
- membership/RBAC;
- billing/quotas;
- dashboard UI;
- master-key migration for destination credentials;
- destination OAuth;
- new destination adapters;
- project deletion;
- generalized producer/profile editor;
- SDK generation;
- full OpenAPI publication unless it is a low-cost output of implementation;
- changing OTLP ingest into an ETLayer proprietary endpoint;
- replacing the internal acceptance suite.

# Definition of done

VS12 is complete when all of the following are true:

~~~text
public /api/v1 boundary               proven
stable machine error codes            proven
idempotent onboarding                 proven
lost-response credential retry        proven
same-key/different-request conflict   proven
public event status                   proven
cross-project isolation               proven
external fixture uses no internals    proven
real OTLP event                       proven
real destination delivery             proven
VS8 -> VS11 regression suite          green
~~~

At that point ETLayer has crossed an important boundary:

~~~text
working data-plane prototype
        ->
consumable versioned product contract
~~~

That is the purpose of VS12.


## Final acceptance evidence

VS12 is complete.

Final runtime proof was executed from commit:

~~~text
40eb989303f54814f0bde5901b14768634479024
~~~

Verification:

~~~text
CI #640                 success
Live Acceptance #66    success
suite                   VS8 -> VS12
~~~

The final VS12 live consumer used:

~~~text
project:
  vs12-20260923-232433-a44c9d64-a

event:
  4700335c-d23d-43a7-b883-9e84d8ed66f8

idempotency key fingerprint:
  08033456a810191593c95077fafd935faae53034293d08d36e8263131009be51
~~~

The external consumer proved:

~~~text
public onboarding                 true
same-key/same-request replay      true
same producer credential replay  true
same-key/different-request        409 idempotency_key_reused
validation                        valid
authority                         allowed
routeEligible                     true
PostHog delivery                  exported
cross-project public status       401 invalid_operator_credential
encrypted idempotency evidence    true
external-consumer boundary        true
~~~

The fixture consumed only:

~~~text
ETLAYER_BASE_URL
ETLAYER_PROJECT_ID
ETLAYER_OPERATOR_CREDENTIAL
~~~

and the static boundary check prohibited internal ETLayer routes, R2/registry coordinates, Wrangler/Cloudflare credentials, the global management credential, and implementation-package imports.

The durable idempotency evidence was inspected only by privileged acceptance setup and proved that:

- the record reached `completed`;
- the response replay capsule used AES-256-GCM;
- the key version was `v1`;
- the durable JSON contained no plaintext `etl_prod_` producer credential;
- the plaintext idempotency key was not persisted.

Independent provider-side verification in PostHog EU project `117513` found exactly the accepted event row:

~~~text
uuid:
  4700335c-d23d-43a7-b883-9e84d8ed66f8

event:
  account.created

etlayer.event.id:
  4700335c-d23d-43a7-b883-9e84d8ed66f8

etlayer.project.id:
  vs12-20260923-232433-a44c9d64-a
~~~

PostHog recorded the client event timestamp at `2026-09-24T02:24:56.005+03:00` and ingestion at `2026-09-24T02:25:09.205+03:00`.

Therefore VS12 proved the complete public contract:

~~~text
clean external consumer
  -> versioned public onboarding
  -> idempotent lost-response recovery
  -> standard OTLP event
  -> versioned public event status
  -> trusted project-scoped destination delivery
~~~

without requiring the external consumer to know ETLayer internal storage or operator surfaces.

## Acceptance hardening discovered by VS12

The serial suite exposed an important encryption-key lifecycle issue in the acceptance harness.

Earlier acceptance helpers rotated `ETLAYER_DESTINATION_SECRET_KEY_V1` between slices. On Cloudflare, secret/deployment propagation can temporarily leave different active Worker/Queue executions on different versions. A credential encrypted under the new root could therefore be read by a stale execution still holding the previous root.

That behavior is incorrect for a versioned encryption root.

The corrected CI model is:

~~~text
ETLAYER_DESTINATION_SECRET_KEY_V1
ETLAYER_IDEMPOTENCY_SECRET_KEY_V1
        |
        +-- provision once in CI bootstrap
        +-- remain stable across acceptance runs
        +-- never rotated as ordinary test credentials
~~~

Future rotation must introduce a new key version and perform deliberate migration. Acceptance scripts may continue to rotate ordinary management/producer credentials, but not encryption roots.

This hardening is now part of the documented CI bootstrap and VS11/VS12 key-lifecycle model.

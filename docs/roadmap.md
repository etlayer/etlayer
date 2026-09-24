# ETLayer Roadmap

This roadmap describes the current product sequence after the completion of VS13.

It is intentionally outcome-driven. A roadmap item becomes a numbered vertical slice only when it has a concrete invariant and executable acceptance proof.

## Current state

~~~text
Phase 1 - Data Plane Foundation
VS1  Preserve + Replay                         complete
VS2  Multi-destination                        complete
VS3  Contracts + Governance                   complete
VS4  Privacy                                  complete
VS5  Subject / Actor / Delegation             complete
VS6  Trusted Provenance / Authority           complete
VS7  Decision History / Policy Lineage        complete
VS8  Project Isolation                        complete
VS9  Dynamic Management                       complete
VS10 External Onboarding                      complete
VS11 Project-scoped Destination Credentials   complete

Phase 2 - Product Contract
VS12 External Integration Contract            complete
VS13 Versioned Encryption Roots & Safe Rotation complete
VS14 First-class Quarantine                    complete
VS15 Append-only Control-plane Audit Log          complete
VS16 Contract Compatibility Checker               complete
~~~

The serial Cloudflare live acceptance suite currently re-proves VS8 -> VS15 together.

See:

- [Post-VS11 Architecture Review](reviews/post-vs11-architecture-review.md)
- [Post-VS12 Architecture Review](reviews/post-vs12-architecture-review.md)
- [Technical Capability Gap Analysis](reviews/technical-gap-analysis.md)
- [VS12: External Integration Contract](vertical-slices/vs12-external-integration-contract.md)
- [VS13: Versioned Encryption Roots & Safe Rotation](vertical-slices/vs13-encryption-root-rotation.md)
- [VS14: First-class Quarantine](vertical-slices/vs14-quarantine.md)
- [VS15: Append-only Control-plane Audit Log](vertical-slices/vs15-control-plane-audit.md)
- [VS16: Contract Compatibility Checker](vertical-slices/vs16-contract-compatibility.md)
- GitHub issues #43, #48, #50, and #52

## Phase 2 - Product Contract

### VS12 - External Integration Contract

**Purpose:** prove ETLayer from the perspective of an application that does not know ETLayer internals.

Target invariant:

~~~text
documented versioned public contract
  + issued credentials
  + standard OTLP
  + public event status
  =
sufficient to integrate and operate
~~~

Selected public boundary:

~~~text
POST /api/v1/projects/:projectId/onboarding
GET  /api/v1/projects/:projectId/events/:eventId

POST /v1/logs
  remains standard OTLP ingest
~~~

VS12 acceptance proved:

- a versioned external API surface;
- stable machine-readable error codes;
- required idempotency for secret-bearing onboarding;
- retry of a lost onboarding response returns the same logical/credential result without duplicate mutation;
- same idempotency key with a different request is rejected;
- explicit global-management vs project-operator capabilities;
- a clean external consumer can onboard, emit OTLP, and inspect outcome;
- no R2 key knowledge;
- no Wrangler or Cloudflare credentials in the external consumer;
- no /_mgmt or /_ops dependency in the external consumer;
- no ETLayer implementation-package imports;
- cross-project inspection remains denied;
- independent destination proof succeeds;
- VS8 -> VS11 regressions remain green.

The design deliberately introduces a dedicated encryption domain for bounded idempotency response replay rather than persisting one-shot producer credentials in plaintext or reusing the destination-provider secret key.

See the full design document for API/error/idempotency semantics.

### VS12 completion evidence

Final proof:

~~~text
CI #640                 green
Live Acceptance #66    green
runtime head            40eb989303f54814f0bde5901b14768634479024
external project        vs12-20260923-232433-a44c9d64-a
event                   4700335c-d23d-43a7-b883-9e84d8ed66f8
PostHog delivery        independently verified
~~~

VS12 established the first versioned product boundary and completed the initial External Integration Contract slice.

### Product-contract follow-ups

Do only when required by the external integration proof:

- project status/read surface beyond event status;
- safe resume/compensation for broader partial onboarding cases;
- project retirement/deletion semantics;
- producer re-enable or replacement semantics;
- API deprecation/compatibility policy hardening;
- generated OpenAPI/schema if the public surface is stable enough;
- CLI/client helpers only as thin consumers of the public API.

## Security track

Near-term, before long-lived hosted production credentials become common:

### VS13 - Versioned Encryption Roots & Safe Rotation

**Complete and live-proven.**

VS13 hardens the two existing encrypted-state domains without introducing a generic KMS abstraction.

Destination credentials are long-lived and require append-only rewrap:

~~~text
v1 ciphertext
  -> add v2 root
  -> new writes use v2
  -> decrypt old record with v1
  -> encrypt the same provider secret with v2
  -> append a new encrypted version
  -> advance the current pointer
  -> retire v1 only after no active pointer depends on it
~~~

Public idempotency capsules are bounded and use dual-read plus expiry drain:

~~~text
unexpired v1 capsule
  -> remains readable with v1

new capsule
  -> uses v2

no unexpired v1 capsules
  -> v1 becomes retirement-safe
~~~

VS13 also requires machine-readable key-usage evidence so root retirement is based on authoritative durable state rather than operator memory.

See the VS13 design document and issue #43.

### Credential lifecycle

Future requirements may include:

- expiry;
- scheduled rotation;
- revocation reason/evidence;
- retention of historical encrypted versions;
- destination OAuth when a real provider requires it.

### Abuse and service protection

Before a public hosted service:

- rate limits;
- quotas;
- payload/body limits;
- project-level resource limits;
- authentication brute-force controls;
- documented failure semantics.

## Trust Governance milestone

The technical capability gap analysis identified a small set of capabilities that strengthen ETLayer's existing trust model before broader hosted-product surfaces are built.

See [Technical Capability Gap Analysis](reviews/technical-gap-analysis.md) for the full classification scheme and longer backlog.

**VS14 - First-class Quarantine is complete and live-proven.**

Its target invariant is:

~~~text
recoverable contract/data-quality failure != semantic trust violation

authority denied      -> BLOCK
validation failure    -> QUARANTINE
otherwise             -> ALLOW
~~~

Routing occurs only for ALLOW, and BLOCK takes precedence over QUARANTINE when both conditions exist.

Live Acceptance #93 proved VS8 -> VS14 serially in the isolated Cloudflare CI environment.

**VS15 - Append-only Control-plane Audit Log is complete and live-proven.**\n\nIts target invariant is:\n\n~~~text\nno authenticated internal management mutation\n  proceeds without durable audit intent\n\nsuccess -> requested + applied\nfailure -> requested + failed\n~~~\n\nThe audit is append-only, actor/target attributable, and secret-safe.

Live Acceptance #95 proved VS8 -> VS15 serially in the isolated Cloudflare CI environment.

**VS16 - Contract Compatibility Checker is complete and CI-proven.**\n\nIt defines backward, forward, and full compatibility over ETLayer's actual contract language and provides a deterministic CLI/CI gate. Because the capability is pure governance logic with no runtime dependency, normal CI is its authoritative executable acceptance rather than Cloudflare deployment.

The next sequencing candidate is `etlayer plan`: simulate proposed contract/policy changes against preserved historical evidence before publication. It does not become VS17 until its risk, invariant, executable acceptance, and smallest useful scope are explicit.

The milestone backlog is:

~~~text
A1-NOW-GOV/OPS  Quarantine
A1-NOW-GOV/SEC  Control-plane Audit Log
A2-NOW-GOV/DX   Contract Compatibility Checker
A2-NOW-GOV/DX   etlayer plan
A2-NOW-OPS/UX   Delivery + Attempt
A2-NOW-GOV/DX   Governance-as-Code
~~~

Expanded meanings:

- **A1-NOW-GOV/OPS - Quarantine:** core, small effort, do now; Governance + Operations / Reliability / Observability.
- **A1-NOW-GOV/SEC - Control-plane Audit Log:** core, small effort, do now; Governance + Security.
- **A2-NOW-GOV/DX - Contract Compatibility Checker:** core, medium effort, do now; Governance + Developer Experience.
- **A2-NOW-GOV/DX - `etlayer plan`:** core, medium effort, do now; Governance + Developer Experience.
- **A2-NOW-OPS/UX - Delivery + Attempt:** core, medium effort, do now; Operations / Reliability / Observability + User Experience.
- **A2-NOW-GOV/DX - Governance-as-Code:** core, medium effort, do now; Governance + Developer Experience.

These are milestone capabilities, not pre-assigned VS numbers. Preserve the roadmap rule: promote one capability into the next vertical slice only after its risk, invariant, executable acceptance, and smallest useful scope are explicit.

A useful sequencing hypothesis is:

~~~text
Quarantine
  -> Audit Log
  -> Compatibility
  -> etlayer plan
  -> Delivery / Attempt
  -> Governance-as-Code
~~~

This sequence is deliberately revisable. The invariant/acceptance proof for the next slice remains authoritative over the ordering hypothesis.

## Phase 3 - Hosted Product

Do not build these merely because SaaS products usually have them. Add them when the external product contract is stable enough to consume.

Candidate capabilities:

- accounts/workspaces/organizations;
- users and membership;
- RBAC;
- dashboard;
- project onboarding UI;
- event inspection UI;
- destination configuration UI;
- quotas;
- billing;
- service-level operational controls.

The UI must consume the same supported product API rather than use privileged storage internals.

## Operations track

A hosted ETLayer needs its own production operating model.

Future proofs should cover:

- service SLOs;
- queue/backlog health;
- delivery failure rates;
- R2/storage growth;
- dead-letter handling;
- replay operational safety;
- backup/recovery;
- incident runbooks;
- retention and cost controls;
- deployment/rollback;
- customer-visible failure semantics.

## Destination track

Current proven destinations:

- PostHog;
- Statsig.

Do not optimize for connector count.

Add a destination when it proves a new requirement.

Strong candidates are destinations with a materially different semantic role, such as:

- warehouse/lake export;
- audit/security sink;
- generic event-stream destination.

Only introduce an adapter capability/projection manifest when multiple real adapters demonstrate that the distinction is useful.

## Agent-native track

The foundation already separates:

~~~text
subject
actor
delegation
producer
authority
provenance
correlation
causation
~~~

Do not create an agent-specific core or framework-specific schema.

Future work should be requirement-driven:

- privacy-safe agent content fields, only when needed;
- audit/security projection, if a real consumer requires richer accountability;
- multi-parent causal links, only if real fan-in cannot be modeled adequately;
- prefer upstream OpenTelemetry semantic conventions whenever they exist.

## Explicitly not on the immediate roadmap

- identity graph;
- prompt warehouse;
- agent workflow engine;
- proprietary replacement for OTLP;
- generalized causal graph database;
- arbitrary policy programming language;
- connector-count expansion without a product requirement.

## Roadmap rule

A new vertical slice should answer all four questions before implementation:

1. What user or architectural risk are we reducing?
2. What invariant will become true?
3. What executable acceptance proves it?
4. Why is this the smallest slice that proves it?

If those answers are weak, keep the item as research/backlog rather than assigning the next VS number.

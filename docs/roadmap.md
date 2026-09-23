# ETLayer Roadmap

This roadmap describes the current product sequence after the completion of VS11.

It is intentionally outcome-driven. A roadmap item becomes a numbered vertical slice only when it has a concrete invariant and executable acceptance proof.

## Current state

```text
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
```

The serial Cloudflare live acceptance suite currently re-proves VS8 -> VS11 together.

See [Post-VS11 Architecture Review](reviews/post-vs11-architecture-review.md).

## Phase 2 - Product Contract

### Candidate VS12 - External Integration Contract

**Purpose:** prove ETLayer from the perspective of an application that does not know ETLayer internals.

Target invariant:

```text
documented public contract
  + issued credentials
  + OTLP
  + inspection
  =
sufficient to integrate and operate
```

Acceptance should prove:

- versioned external API surface;
- stable machine-readable errors;
- idempotent/retry-safe onboarding mutations;
- explicit global-management vs project-operator capabilities;
- one-shot/redacted credential behavior;
- clean external consumer integration;
- no R2 key knowledge;
- no Wrangler requirement;
- no internal diagnostic evidence dependency;
- VS8 -> VS11 regressions remain green.

### Product-contract follow-ups

Do only when required by the external integration proof:

- project status/read surface;
- safe resume/compensation for partial onboarding;
- project retirement/deletion semantics;
- producer re-enable or replacement semantics;
- API deprecation/compatibility policy;
- generated OpenAPI/schema if the public surface is stable enough;
- CLI/client helpers only as thin consumers of the public API.

## Security track

Near-term, before long-lived hosted production credentials become common:

### Master-key version rotation

Prove:

```text
v1 active credentials
  -> introduce v2
  -> re-encrypt/migrate
  -> verify decrypt/delivery
  -> retire v1 according to retention policy
```

Requirements:

- never overwrite an in-use key version;
- migration is resumable/idempotent;
- active pointer never references undecryptable material;
- audit evidence explains key-version transition;
- rollback behavior is explicit.

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

```text
subject
actor
delegation
producer
authority
provenance
correlation
causation
```

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

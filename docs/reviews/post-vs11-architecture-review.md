# Post-VS11 Architecture Review

**Status: Phase 1 foundation review after VS11.**

## Executive summary

ETLayer has completed the architectural foundation that began with VS1.

The system is no longer only an OTLP-to-analytics gateway. It now has a coherent data-plane model for product and business events with:

- authenticated producer provenance;
- project isolation;
- executable contracts;
- privacy enforcement before durable storage and routing;
- subject, actor, delegation, correlation, and causation semantics;
- authority enforcement;
- policy-clean canonical preservation;
- append-only decision lineage;
- independent destination projections;
- replay and revalidation;
- dynamic project and producer management;
- first external onboarding;
- project-scoped encrypted destination credentials.

The VS8 -> VS11 live acceptance suite proves these invariants together in an isolated Cloudflare environment.

The main architectural risk has therefore moved.

Before VS11, the primary risk was whether the event data plane could preserve, govern, isolate, and route trustworthy evidence.

After VS11, the primary risk is whether an external application can consume ETLayer through a stable, explicit, operable product contract without depending on repository internals or operator knowledge.

This review marks:

```text
VS1 - VS11
    =
Phase 1: Data Plane Foundation
    =
COMPLETE
```

The recommended next experiment is not another semantic primitive or another destination.

It is a product-boundary proof:

> A clean external application should be able to integrate with ETLayer using only a documented, versioned public contract and issued credentials, with no knowledge of R2 paths, Wrangler, internal management evidence, or ETLayer repository internals.

That is the strongest candidate for VS12.

---

## Current architecture

```text
producer
   |
   | authenticated credential
   v
OTLP / HTTP
   |
   v
trusted ingest provenance
   |
   +--> mandatory privacy policy
   |
   +--> event contract validation
   |
   +--> authority policy
   |
   +--> identity / subject / actor / delegation
   |
   +--> append-only decision evidence
   |
   v
project-scoped policy-clean canonical archive
   |
   +--> replay
   +--> revalidation
   +--> inspection
   |
   v
project-scoped destination routing
   |
   +--> PostHog
   +--> Statsig
   +--> future projections
```

Dynamic projects additionally have:

```text
global management authority
   |
   v
project
   |
   +--> project operator credential
   +--> producer registrations
   +--> producer credentials
   +--> destination enablement
   +--> encrypted destination credentials
```

Destination provider credentials for dynamic projects are encrypted before R2 persistence and are resolved only at delivery/replay time.

---

## What Phase 1 proved

### VS1 - Preservation and replay

Proved:

- OTLP/HTTP ingest;
- Cloudflare Queue processing;
- durable canonical archive;
- PostHog projection;
- replay without producer re-emission.

Architectural result:

> Producers emit a semantic event once. ETLayer owns durable evidence and destination projection.

### VS2 - Independent destinations

Proved:

- PostHog and Statsig can project from one canonical event;
- destination outcomes are independent;
- destination-specific replay is possible.

Architectural result:

> Destination APIs are not the application event contract.

### VS3 - Contracts and governance

Proved:

- versioned business-event contracts;
- validation evidence;
- blocked events remain inspectable;
- deterministic revalidation.

Architectural result:

> Event shape and meaning are executable policy, not documentation only.

### VS4 - Privacy

Proved:

- secret material can be removed before Queue/R2;
- direct identifiers can remain canonical while being removed from analytics projections;
- privacy decisions are durable evidence.

Architectural result:

> Canonical means policy-clean canonical, not raw request bytes.

### VS5 - Identity and agent-native semantics

Proved:

- analytics subject and immediate actor are separate;
- delegation is explicit;
- anonymous-to-user continuity survives destination projection;
- agent/subagent activity can preserve one user journey without erasing accountability.

Architectural result:

```text
subject != actor
```

### VS6 - Trusted provenance and authority

Proved:

- trusted producer identity comes from the ingest boundary;
- payload producer claims cannot override trusted provenance;
- authority is enforced independently from structural validity;
- browser/agent credentials cannot forge backend business-state authority.

Architectural result:

```text
producer claim != trusted provenance
actor          != authority
```

### VS7 - Append-only decision lineage

Proved:

- initial processing creates immutable decision evidence;
- revalidation creates a new decision;
- a latest pointer can advance without rewriting history;
- policy versions are preserved with the decision.

Architectural result:

> Current interpretation can change without rewriting historical evidence.

### VS8 - Project isolation

Proved:

- credential selects trusted project;
- payload cannot select project;
- canonical and derived evidence are project-namespaced;
- routing, replay, revalidation, and operator access are project-scoped;
- the same logical event ID can exist independently in two projects.

Architectural result:

```text
tenant identity is trusted context, not event payload
```

### VS9 - Dynamic management

Proved:

- projects can be created dynamically;
- project operator and producer credentials can be generated;
- producer credentials are fingerprinted rather than persisted in plaintext;
- producer credentials can rotate and be disabled;
- destination enablement is project-scoped.

Architectural result:

> Multi-project behavior no longer depends only on static reference configuration.

### VS10 - First external onboarding

Proved:

- an operator can provision a project-facing onboarding bundle;
- a producer credential is returned once;
- canonical OTLP connection metadata can be generated;
- a copy-ready Node quickstart can emit a real event;
- project operators can inspect an event using project ID + event ID;
- cross-project inspection is denied.

Architectural result:

> ETLayer has the beginning of an external product surface, not only internal acceptance helpers.

### VS11 - Project-scoped destination credentials

Proved:

- dynamic projects can use independent destination provider credentials;
- plaintext provider credentials are encrypted before persistence;
- AES-256-GCM uses fresh IVs;
- AAD binds ciphertext to project, destination, credential ID, and key version;
- provider credential rotation preserves delivery;
- disabling a project destination credential stops that project without falling back to a Worker-global token;
- replay uses the same credential resolver as normal delivery.

Architectural result:

> Project-scoped routing now has project-scoped destination authentication.

---

## Architectural laws after VS11

The following invariants should be treated as architectural laws until deliberately superseded:

```text
1. OpenTelemetry remains the producer transport boundary where practical.

2. Event meaning belongs to the application/domain, not to a destination SDK.

3. Mandatory ingest privacy runs before durable canonical storage.

4. Canonical means policy-clean, replayable evidence.

5. Subject, actor, producer, authority, and project are independent dimensions.

6. Delegation never overwrites the immediate actor.

7. Trusted provenance comes from authentication/registration, not payload claims.

8. Project identity comes from trusted credentials/configuration, not payload claims.

9. Structurally valid does not imply authority-allowed.

10. Historical decisions are append-only.

11. Revalidation may produce a new interpretation without rewriting original evidence.

12. Replay re-projects historical evidence. It never repeats the original business/tool side effect.

13. Destination adapters are lossy projections, never semantic authorities.

14. Dynamic projects must not fall back to global provider credentials.

15. Plaintext producer and destination credentials must not be durable repository/registry state.

16. Cloudflare is the first runtime, not a semantic dependency of the event model.
```

---

## What is intentionally still incomplete

The following are not regressions or unfinished VS11 work. They are deferred productization or future architecture work.

### Public control-plane identity

Current slices intentionally do not provide:

- public signup/auth;
- organizations/accounts/workspaces;
- user membership;
- arbitrary RBAC;
- billing or quotas.

The current global management credential is appropriate for acceptance and operator-controlled provisioning, but it is not a long-term public SaaS identity model.

### Stable public API contract

Current product-facing operations exist, but the repository has not yet proven:

- a versioned public API namespace;
- compatibility guarantees;
- explicit error contract;
- idempotency guarantees for provisioning mutations;
- deprecation policy;
- generated API schema/client contract.

The `/_mgmt` and `/_ops` names should be treated as implementation-era surfaces until a public contract is deliberately frozen.

### Transactional onboarding lifecycle

VS10 explicitly deferred transactional multi-resource onboarding rollback.

A partial onboarding failure needs a defined contract:

```text
retry safely
or
resume safely
or
compensate safely
```

Without this, external automation eventually has to understand internal partial states.

### Project lifecycle

Still deferred:

- project deletion/retirement;
- producer re-enable;
- richer project status;
- resource lifecycle/retention semantics.

These should not be added as isolated CRUD for completeness. They should be driven by a real external lifecycle.

### Master-key rotation

VS11 supports provider credential rotation, not encryption-master-key rotation.

A persistent environment eventually needs:

```text
v1 master key
    |
introduce v2
    |
re-encrypt/migrate active credentials
    |
verify
    |
retire v1 when policy permits
```

Overwriting `ETLAYER_DESTINATION_SECRET_KEY_V1` in a persistent environment is not a rotation strategy.

### Destination ecosystem

Only PostHog and Statsig are currently proven.

Do not add adapters only to increase connector count.

A third destination should test a new semantic shape, for example a warehouse/audit/event sink, and should justify any adapter capability manifest.

### UI

A dashboard is intentionally not part of the foundation.

The inspection API should become stable enough that a future UI is a consumer of the same public product contract rather than a privileged path around it.

### Operations of ETLayer itself

The slices strongly test customer-event correctness, but a production service will also need explicit SLOs, operator telemetry, failure-mode runbooks, retention/cost controls, abuse/rate-limit policy, and disaster/recovery procedures.

Those concerns should be documented and proven as the service moves from reference deployment toward a hosted product.

---

## The most important post-VS11 question

The key question is no longer:

> Can ETLayer preserve and govern a trustworthy event?

VS1-VS11 answer that well enough for the current stage.

The next question is:

> Can someone outside the ETLayer repository integrate and operate against ETLayer without learning its internals?

VS10 moved toward this, but its acceptance still runs from the ETLayer repository and uses ETLayer-owned acceptance infrastructure.

That leaves an important gap between:

```text
we can generate onboarding instructions
```

and:

```text
an external consumer can rely on the product contract
```

---

## Recommended VS12 candidate - External Integration Contract

### Goal

Prove ETLayer from the point of view of a clean external application.

### Core invariant

```text
external application
  receives documented endpoint + credentials
  emits OTLP
  inspects outcome
  rotates/replaces what it is allowed to rotate
  handles documented errors

without:
  R2 knowledge
  Wrangler access
  ETLayer repository internals
  registry evidence paths
  Worker-global secrets
```

### What VS12 should prove

1. A deliberately versioned external API surface exists.

2. Onboarding mutations have explicit idempotency/retry semantics.

3. Public error responses have stable machine-readable codes.

4. A clean external fixture can integrate using documentation and returned connection metadata only.

5. The fixture does not call diagnostic evidence endpoints or know R2 key layouts.

6. Project operator capabilities are explicitly separated from global management capabilities.

7. Credential values are one-shot where intended and redacted on later reads.

8. Event inspection remains sufficient for the external consumer to determine processing outcome.

9. Acceptance runs from an external-consumer boundary rather than relying on ETLayer internal helper functions.

10. Existing VS8 -> VS11 isolation/security proofs remain green.

### Strong acceptance shape

Prefer a small independent consumer repository or otherwise isolated acceptance package whose contract is intentionally limited to public ETLayer surfaces.

The test should fail if it imports ETLayer implementation modules or uses internal storage coordinates.

### Non-goals

VS12 should not simultaneously build:

- public signup;
- billing;
- dashboard UI;
- generalized RBAC;
- a proprietary ingest SDK;
- many new destinations;
- master-key rotation;
- Terraform/provider automation.

Those are separate product decisions.

---

## Why not make master-key rotation VS12?

It is important, but the current system can remain correct with a stable v1 key in a controlled environment.

Master-key rotation becomes urgent before long-lived production credentials accumulate, but it does not answer whether the product boundary is usable.

It should be a near-term security slice, not forgotten backlog.

---

## Why not make organizations/billing VS12?

Organizations, users, RBAC, billing, and quotas are product/control-plane concerns with wide blast radius.

Building them before proving a stable external integration contract risks hardening the wrong surface.

First prove the contract a future dashboard, CLI, account system, and automation layer should consume.

---

## Why not add another destination next?

PostHog + Statsig already prove multi-destination mechanics.

A third adapter is useful only if it forces a new semantic capability or represents a real customer requirement.

Connector count is not the current bottleneck.

---

## Recommended phase model

```text
Phase 1 - Data Plane Foundation
  VS1 - VS11
  COMPLETE

Phase 2 - Product Contract
  external integration contract
  idempotent onboarding/lifecycle
  stable errors and API versioning
  client-facing documentation
  control-plane boundary hardening

Phase 3 - Hosted Product
  account/workspace identity
  membership/RBAC
  UI
  quotas/billing
  service SLOs and operational controls

Security track
  master-key version rotation
  retention/deletion policy
  credential expiry/rotation policy
  abuse/rate limits

Destination track
  add only requirement-driven adapters
  introduce capability metadata only when real semantic differences require it
```

The phase tracks may interleave. They are not a promise that every item becomes a numbered vertical slice.

---

## Decision

Phase 1 is complete.

Do not extend VS1-VS11 merely to make the foundation look more feature-complete.

The recommended next vertical experiment is **VS12: External Integration Contract**, provided it remains narrowly scoped to proving the public product boundary.

Before implementing VS12, repository documentation should be updated to reflect the actual VS11 architecture and the stale pre-VS6 review PR should be closed.

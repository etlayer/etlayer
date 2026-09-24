# Post-VS12 Architecture Review

**Status: complete.**

VS12 crossed ETLayer from a repository-internal integration surface into a versioned external product contract.

This review asks what risk should be reduced next.

## Current state after VS12

ETLayer has now proven:

- durable policy-clean event preservation;
- replay and revalidation;
- independent destination projection;
- executable event contracts;
- privacy enforcement before durable storage/routing;
- subject / actor / delegation semantics;
- trusted producer provenance;
- authority enforcement;
- append-only decision lineage;
- project isolation;
- dynamic project and producer management;
- external onboarding;
- project-scoped encrypted destination credentials;
- a versioned public API;
- stable public error codes;
- retry-safe secret-bearing onboarding;
- a clean external-consumer acceptance boundary.

The current public product contract is:

~~~text
POST /api/v1/projects/:projectId/onboarding
GET  /api/v1/projects/:projectId/events/:eventId

POST /v1/logs
  remains standard OTLP ingest
~~~

The serial live acceptance suite re-proves VS8 -> VS12 together.

## What VS12 changed

Before VS12, the main product risk was whether a clean external application could consume ETLayer without knowing internal storage/operator details.

That risk is now proven.

VS12 also exposed a more fundamental operational/security fact:

> Encryption root versions are durable data dependencies, not disposable deployment secrets.

During acceptance hardening, rotating a v1 encryption root in place could temporarily leave different Cloudflare executions with incompatible decryptability.

The corrected acceptance model already treats these roots as stable versioned dependencies:

~~~text
ETLAYER_DESTINATION_SECRET_KEY_V1
ETLAYER_IDEMPOTENCY_SECRET_KEY_V1
~~~

Both persisted record types already store keyVersion.

However, runtime key resolution still understands only v1.

This means ETLayer currently has a version field without an implemented version lifecycle.

That is the strongest immediate architectural gap.

---

# Candidate next directions

## A. Encryption root rotation

### Existing pressure

This is not hypothetical future product scope.

ETLayer already stores encrypted durable state in two domains:

~~~text
destination credentials
  long-lived

idempotency response capsules
  bounded replay lifetime
~~~

Both depend on roots that cannot safely be overwritten.

### Risk if deferred

For destination credentials:

~~~text
remove/overwrite v1
  -> current ciphertext may become undecryptable
  -> destination delivery/replay can fail
~~~

For idempotency capsules:

~~~text
remove/overwrite v1
  -> unexpired lost-response recovery can fail
~~~

### Slice quality

This has a crisp executable invariant and does not require hosted SaaS identity, UI, billing, or a general secrets platform.

It is a strong vertical slice.

---

## B. Accounts / workspaces / RBAC

This is necessary for a hosted multi-user product, but it is a wide product-control-plane expansion.

It introduces:

- user authentication;
- organizations/workspaces;
- membership;
- roles/permissions;
- invitations;
- ownership lifecycle;
- potentially billing linkage.

VS12 proved the project API first specifically so these later surfaces can consume a stable contract.

Building them now is possible, but they do not resolve the already-present encryption lifecycle risk.

**Decision: defer.**

---

## C. OpenAPI / CLI

Now that a versioned public API exists, both are reasonable.

But they are consumers/descriptions of the contract rather than a core safety invariant.

A CLI should remain a thin client over /api/v1.

OpenAPI is useful once the public surface grows enough to justify generated clients/docs.

**Decision: useful follow-up, not VS13.**

---

## D. Project lifecycle

Project retirement/deletion, producer replacement, and richer project status remain incomplete.

These should be driven by an actual lifecycle requirement because deletion interacts with:

- canonical evidence retention;
- destination credential history;
- auditability;
- privacy/deletion policy;
- billing/account state.

It is too easy to implement destructive CRUD before defining retention semantics.

**Decision: defer until lifecycle/retention policy is explicit.**

---

## E. Operational readiness / SLOs

This is important before a hosted service.

Future work should cover:

- queue backlog;
- delivery failure rate;
- R2/storage growth;
- DLQ handling;
- service SLOs;
- deployment/rollback;
- disaster recovery;
- customer-visible failure states.

However, root-key lifecycle is a prerequisite for credible disaster recovery and secret restoration.

**Decision: operations is a strong near-term track, likely after key lifecycle.**

---

## F. Rate limits / quotas / abuse protection

Required before exposing a hosted public API broadly.

But quota semantics depend on product/account boundaries not yet selected.

Simple payload limits can be hardened independently later.

**Decision: defer as a hosted-product gate, not VS13.**

---

## G. Dashboard

The public API is finally strong enough that a dashboard can become a normal client.

That is good architecture.

It still should not become the next slice merely because it is visible product work.

A dashboard would not reduce the most immediate correctness/security risk.

**Decision: defer.**

---

# Selected next slice

## VS13 - Versioned Encryption Roots & Safe Rotation

VS13 should prove:

~~~text
old encrypted records remain readable
while
new writes switch to a new root version
and
long-lived encrypted state migrates safely
~~~

without:

~~~text
overwriting v1
rewriting history in place
rotating provider credentials
exposing plaintext
introducing a generic KMS abstraction
changing the public API
~~~

Tracks GitHub issue #43.

---

# Important design distinction

The two encryption domains should not be forced into identical migration mechanics.

## Destination credentials

Destination credentials are long-lived.

They need explicit rewrap:

~~~text
provider secret
  encrypted with root v1
      |
      +-- old append-only encrypted version remains
      |
      -> decrypt under v1
      -> encrypt same provider secret under v2
      -> append new encrypted version
      -> advance current pointer
~~~

Provider credential rotation is a different operation.

The provider secret value must stay unchanged during master-key rewrap.

## Idempotency capsules

Idempotency capsules are intentionally bounded by replayUntil.

They need dual-read key support plus drain:

~~~text
old unexpired v1 capsule
  -> continue reading with v1

new writes
  -> use v2

after all v1 capsules expire
  -> v1 can retire
~~~

Re-encrypting expired capsules adds complexity without product value.

---

# Keyring shape

Do not build a generic vault/KMS provider system.

The smallest correct model is a domain-aware version resolver.

Conceptually:

~~~text
resolveEncryptionRoot(domain, keyVersion)

destination / v1
  -> ETLAYER_DESTINATION_SECRET_KEY_V1

destination / v2
  -> ETLAYER_DESTINATION_SECRET_KEY_V2

idempotency / v1
  -> ETLAYER_IDEMPOTENCY_SECRET_KEY_V1

idempotency / v2
  -> ETLAYER_IDEMPOTENCY_SECRET_KEY_V2
~~~

Each domain also needs an explicit active write version.

The active version is configuration, not secret material.

Persisted records remain authoritative for read version selection.

---

# Retirement readiness

A rotation is incomplete until the old root can be retired safely.

VS13 must make this machine-answerable.

A rare management-time R2 scan is acceptable at current scale.

## Destination rule

A destination root version is not retirement-safe if any active destination pointer references a record encrypted with that version.

## Idempotency rule

An idempotency root version is not retirement-safe if any unexpired replay capsule references that version.

This should produce machine-readable evidence for acceptance and runbooks.

Do not rely on operator memory such as:

> I think everything was migrated.

---

# Public API impact

None is required.

VS13 is internal security/operations infrastructure.

Keep key administration behind global management authority.

The existing external /api/v1 contract should remain unchanged and continue passing acceptance.

---

# Why not KMS now?

KMS is a key-storage/provider decision.

VS13 is a key-lifecycle correctness problem.

A future implementation may resolve root material from:

- Cloudflare secrets;
- a KMS;
- HSM-backed service;
- BYOC secret provider.

But the invariant is the same:

~~~text
record keyVersion
  -> resolve correct historical key
~~~

Introducing KMS now would combine two decisions:

1. how key versions behave;
2. where key material lives.

Only the first is required to close the current risk.

---

# Phase model after review

~~~text
Phase 1 - Data Plane Foundation
  VS1 - VS11
  complete

Phase 2 - Product Contract
  VS12
  complete

Phase 2 - Product Contract / Security hardening
  VS13 Versioned Encryption Roots & Safe Rotation
  selected

Near-term after VS13
  service operations / SLO proof
  project lifecycle + retention semantics
  public API description / CLI when useful

Later hosted product
  accounts/workspaces
  membership/RBAC
  quotas/billing
  dashboard
~~~

The phase boundary is intentionally not renumbered merely because VS13 is security-oriented. It hardens an existing product contract rather than opening the full hosted-product phase.

---

# Decision

Proceed with **VS13 - Versioned Encryption Roots & Safe Rotation**.

Do not add a generic KMS abstraction, hosted account model, or public key-management API in the slice.

The acceptance target is safe coexistence, migration, retirement evidence, and removal of v1 only after the system proves that no still-required encrypted state depends on it.

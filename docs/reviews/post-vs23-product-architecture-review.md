# Post-VS23 Product and Architecture Review

Status: current architecture checkpoint after VS23.

Review date: 2026-09-26.

## Executive summary

ETLayer has completed the first coherent trust-governance core.

The system now has live-proven semantics for:

~~~text
OTLP ingest
  -> authenticated Producer
  -> trusted Provenance
  -> Privacy
  -> Contract validation
  -> Authority
  -> ALLOW / QUARANTINE / BLOCK
  -> canonical evidence
  -> append-only Decision lineage
  -> Delivery
  -> append-only Attempts
~~~

and a governance chain:

~~~text
Compatibility
  -> Historical Plan
  -> Governance-as-Code Manifest
  -> manifestDigest
  -> Guarded Publication
  -> Published / Deprecated / Retired
  -> Ownership
  -> Bounded Governance Metrics
~~~

VS8 -> VS23 is continuously re-proven by the full Cloudflare acceptance suite.

The next architectural risk is no longer missing trust semantics.

It is choosing the next product boundary without accidentally introducing a second source of truth, a fake environment abstraction, or premature SaaS/account complexity.

## What is now structurally strong

### Data-plane trust boundary

The ingest path distinguishes trusted boundary facts from payload claims.

Current invariants include:

~~~text
subject != actor
producer != actor
authority != actor
payload claim != trusted provenance
payload project != trusted project
valid contract != allowed authority
~~~

### Durable evidence

Canonical source events, validation evidence, authority/privacy/identity evidence, Decision lineage, Delivery summaries, Attempts, publication records, lifecycle state, ownership, and control-plane audit evidence are all explicit resources.

This is enough to support inspection, replay, revalidation, governance planning, and bounded operational aggregation without inventing a general event database.

### Contract governance

The governance model now has a real identity chain:

~~~text
reviewable manifest
  -> deterministic normalization
  -> stable manifestDigest
  -> read-only historical plan
  -> exact-digest publication
~~~

The publication boundary does not accept "something equivalent later"; it recomputes the digest and binds mutation to the exact planned normalized manifest.

### Runtime contract lifecycle

Published project-scoped contract versions are immutable.

Their current operational lifecycle is separate:

~~~text
Published
  -> Deprecated
  -> Retired
~~~

Deprecated remains accepted and inspectable.

Retired deterministically quarantines future events with `contract_retired`.

Lifecycle changes do not rewrite historical Decision lineage.

### Ownership

Ownership is current operational metadata attached to the event semantic, not authorization.

That distinction is useful:

~~~text
Decision lineage
  -> what ETLayer decided at evaluation time

Ownership
  -> who currently owns the semantic
~~~

### Governance metrics

VS23 adds a bounded read model rather than persisted counters.

That keeps:

~~~text
durable evidence = source of truth
metrics = derived read model
~~~

This is the correct boundary for the current scale.

## Acceptance architecture

The acceptance model is now intentionally split.

~~~text
PR
  -> current slice live acceptance
  -> fast feedback

main / scheduled / manual
  -> VS8 -> current slice serial regression
  -> accumulated runtime proof
~~~

This recovered fast PR iteration while preserving integration proof.

The full suite has also demonstrated value by exposing pre-existing rollout propagation races rather than only validating the newest slice.

## Important environment-promotion finding

The roadmap previously named Environment Promotion as the likely next vertical slice.

After reviewing the current governance identity model, Environment Promotion is **not yet a clean VS24 candidate**.

The reason is structural.

Current `ProjectGovernance/v1` identity includes:

~~~text
projectId
contract semantics
planning range:
  from
  to
  maxEvents
  maxExamples
~~~

Therefore:

~~~text
manifestDigest
  = identity of one project-bound,
    plan-bound governance proposal
~~~

A dev manifest and a production manifest cannot preserve the exact same `manifestDigest` if:

- dev and production are different ETLayer projects; or
- their historical planning windows differ.

This is not a digest bug.

It means the existing `manifestDigest` is doing exactly what VS19/VS20 intended: identifying the exact proposal that was planned and published in one project context.

## Why not add a fake environment field now

A tempting implementation would add:

~~~text
environment = dev | staging | production
~~~

to a publication record while leaving runtime scoping project-only.

That would create a label, not a real environment boundary.

A real environment model has consequences for:

- Producer credentials;
- canonical event scope;
- history used for planning;
- publication state;
- operator authority;
- destinations;
- ownership;
- lifecycle;
- metrics;
- public API identity.

Without deciding those semantics, an environment label would create ambiguity rather than reduce it.

## Why cross-project promotion is currently blocked

The existing Project is both:

- an isolation/security boundary; and
- the namespace for governance/runtime evidence.

A realistic hosted customer might eventually have:

~~~text
workspace: acme

projects/environments:
  acme-dev
  acme-staging
  acme-prod
~~~

But ETLayer currently has no higher-level resource that proves those projects belong to one promotion domain.

There is no:

- Workspace;
- Project Group;
- Environment Set;
- cross-project project-operator authority.

Using the global management credential for product-level promotion would work mechanically but would be the wrong external authorization model.

Therefore direct cross-project Environment Promotion would prematurely force a workspace/RBAC decision.

## Promotion identity that will likely be needed later

When Environment Promotion becomes concrete, the model probably needs two identities.

### Governance artifact identity

Environment-independent semantic content:

~~~text
artifactDigest =
  digest(
    eventName
    currentVersion
    compatibilityMode
    proposedContract
  )
~~~

This excludes:

- projectId;
- historical planning window;
- target environment.

It answers:

~~~text
is this the same governance change?
~~~

### Governance manifest identity

Existing project-bound planning identity:

~~~text
manifestDigest =
  digest(
    projectId
    artifact semantics
    planning range
    planning bounds
  )
~~~

It answers:

~~~text
is this the exact proposal that was planned here?
~~~

A future promotion can then prove:

~~~text
source artifactDigest
  ==
target artifactDigest

while

source manifestDigest
  !=
target manifestDigest
~~~

That preserves both semantics instead of weakening the current digest.

Do not introduce `artifactDigest` until a concrete promotion workflow requires it.

## What ETLayer is missing now

The remaining work falls into four different product tracks rather than one continuation of the core.

### 1. Hosted product control plane

Needed before ETLayer is a conventional multi-user SaaS:

- Workspace / organization identity;
- users and membership;
- project grouping;
- real environment model;
- RBAC;
- supported project/status APIs;
- UI-facing control-plane APIs.

Environment Promotion belongs here unless a simpler real deployment model appears.

### 2. Developer experience

The core is mature enough for thin developer-facing tooling:

- typed SDK/code generation;
- CLI helpers;
- local contract check/plan workflow;
- live contract debugger;
- contract inference from observed traffic;
- semantic contract search.

These should remain consumers of supported APIs and governance artifacts.

### 3. Production hardening

Before broad hosted usage:

- rate limits;
- quotas;
- payload/body limits;
- brute-force protection;
- credential expiry/revocation;
- project resource limits;
- retention controls;
- backup/recovery;
- deployment/rollback;
- queue/backlog health;
- DLQ operating model;
- service SLOs;
- customer-visible failure semantics.

This is now more important than adding another internal semantic abstraction.

### 4. Human-facing product

The domain model can now support a useful UI:

- project overview;
- event inspection;
- contract catalog;
- ownership;
- lifecycle;
- violations;
- delivery history;
- governance metrics.

A UI should consume supported product APIs rather than R2 paths or internal-only implementation modules.

## Candidate next slices

No VS24 is assigned by this review.

The next slice should be selected from one of these concrete risks.

### Candidate A - Service protection baseline

Risk:

~~~text
a hosted endpoint can be operationally abused
before product/user features even matter
~~~

Potential smallest slice:

- request body limit;
- per-project rate limit;
- machine-readable 429/413 semantics;
- acceptance proving one project cannot exhaust another.

This is the strongest production-hardening candidate.

### Candidate B - Supported project read surface

Risk:

~~~text
a future UI/CLI would need internal /_mgmt or storage knowledge
~~~

Potential smallest slice:

~~~text
GET /api/v1/projects/:projectId
~~~

returning non-secret:

- project status;
- enabled destinations;
- producers summary;
- ownership/lifecycle/metrics links or summary.

This is a strong bridge toward both UI and CLI.

### Candidate C - Typed contract artifact / SDK generation

Risk:

~~~text
contract violations are still discovered primarily at runtime/CI
~~~

Potential smallest slice:

- deterministic machine-readable contract export;
- generated TypeScript type/validator;
- one external producer compile/runtime proof.

This is a strong DX candidate.

### Candidate D - Workspace/environment identity

Risk:

~~~text
multiple projects cannot yet be proven to belong to one promotion domain
~~~

Potential smallest slice:

- Workspace resource;
- project membership in one workspace;
- explicit environment role per project;
- no promotion yet.

Only after this is real should Environment Promotion receive a VS number.

## Recommended sequencing

The current recommendation is:

~~~text
VS1 -> VS23
  complete

now
  -> checkpoint complete
  -> choose one real product risk

preferred:
  Service Protection baseline
  or
  Supported Project Read Surface

then
  -> Hosted Product / DX / Production hardening converge

later, when workspace/environment identity is real
  -> Environment Promotion
~~~

This is intentionally different from blindly assigning VS24 to Environment Promotion.

The roadmap rule still wins:

~~~text
no vertical slice number
without
  concrete risk
  target invariant
  executable acceptance
  smallest useful scope
~~~

## Architectural boundaries to preserve

Do not regress these boundaries while adding product features:

~~~text
OTLP remains transport
ETLayer remains the trust/governance layer
canonical evidence remains authoritative
Decision history remains append-only
Delivery != Attempt
ownership != authorization
project != payload claim
metrics != source of truth
Cloudflare != core semantic dependency
~~~

## Checkpoint conclusion

ETLayer's first trust-governance core is complete enough that the next highest-value work is no longer obvious from architecture alone.

That is a good state.

The system has reached the point where the next slice should be selected by the product we want to expose:

~~~text
hosted SaaS
developer platform
production trust gateway
agent-operable control plane
~~~

The next implementation should make one of those paths materially more real rather than merely adding another internal abstraction.

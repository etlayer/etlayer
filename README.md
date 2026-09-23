# ETLayer

**ETLayer is an OTel-native event data plane for product and business events.**

ETLayer receives OpenTelemetry events, applies business-event semantics and policy, preserves policy-clean replayable evidence, and projects events into analytics and experimentation systems without coupling application code to a vendor.

> Emit once. Own the event. Route and replay it anywhere.

## Why ETLayer?

Product events often start life inside a vendor SDK. That makes the analytics backend part of the application contract and makes migrations, replay, governance, multi-destination routing, and trustworthy automation harder than they should be.

ETLayer keeps those concerns separate.

```text
Applications / services / agents
            |
            | OTLP
            v
       ETLayer ingest
            |
            +-- trusted provenance
            +-- mandatory privacy
            +-- contracts
            +-- authority
            +-- identity / actor / delegation
            +-- decision lineage
            |
            v
 project-scoped canonical evidence
            |
            +-- replay
            +-- revalidation
            +-- inspection
            |
            v
 project-scoped destination routing
       |                 |
       v                 v
    PostHog            Statsig
```

ETLayer is not an analytics UI and is not intended to replace OpenTelemetry.

OpenTelemetry owns instrumentation and transport where practical. ETLayer focuses on product/business event semantics, governance, durable evidence, project isolation, and vendor-neutral projection after ingestion.

## Core semantic model

ETLayer deliberately keeps these dimensions separate:

```text
subject     - who the product journey/event is about
actor       - who or what directly acted
delegation  - on whose behalf / through whom
producer    - which authenticated producer supplied the evidence
authority   - what that producer is allowed to assert
provenance  - trusted identity established at the ingest boundary
project     - trusted tenant/project scope
causation   - direct causal predecessor
correlation - larger activity/journey grouping
```

Important invariants include:

```text
subject != actor
producer != actor
authority != actor
payload claim != trusted provenance
payload project != trusted project
valid contract != allowed authority
```

## Current implementation

The reference implementation targets Cloudflare:

```text
OTLP/HTTP
   |
Cloudflare Worker
   |
Cloudflare Queue
   |
   +-- project-scoped R2 canonical/evidence storage
   +-- PostHog projection
   +-- Statsig projection
   +-- replay
   +-- revalidation
   +-- inspection
```

Dynamic project support includes:

- project creation;
- project operator credentials;
- producer registration and credential rotation/disable;
- project-scoped destination enablement;
- external onboarding metadata and quickstart generation;
- event inspection by project ID + event ID;
- project-scoped encrypted destination provider credentials.

Provider credentials for dynamic projects are encrypted before R2 persistence with AES-256-GCM and are decrypted only for delivery/replay.

## Vertical slice status

Phase 1 - Data Plane Foundation is complete through VS11.

```text
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

The current live acceptance suite re-proves VS8 -> VS11 serially in an isolated Cloudflare CI environment.

See:

- [Roadmap](docs/roadmap.md)
- [Post-VS11 Architecture Review](docs/reviews/post-vs11-architecture-review.md)
- [VS11: Project-scoped destination credentials](docs/vertical-slices/vs11-project-destination-credentials.md)
- [Acceptance helpers](scripts/once/README.md)

## Design principles

- OTel-native, not OTel-adjacent
- Vendor-neutral application instrumentation
- Policy-clean canonical evidence before lossy projections
- Explicit, versioned business-event contracts
- Trusted provenance established at the ingest boundary
- Authority enforced independently from event validity
- Subject, actor, producer, authority, and project remain separate dimensions
- Replay and revalidation as first-class capabilities
- Historical decision evidence is append-only
- Project isolation applies to storage, policy, operations, routing, and credentials
- Cloudflare is the first runtime, not a core semantic dependency

## Next phase

The foundation is no longer the main unknown.

The next product question is whether an external application can integrate and operate against ETLayer using only a documented, versioned public contract and issued credentials, without knowledge of R2 paths, Wrangler, registry internals, or ETLayer implementation details.

The current strongest candidate for the next vertical experiment is **External Integration Contract**. See the roadmap and Post-VS11 review for the proposed acceptance boundary.

## Stability

ETLayer is still pre-stable.

The core architecture has been proven through VS11, but public API naming, control-plane identity, hosted-product surfaces, and some operational/security lifecycle features are intentionally not frozen yet.

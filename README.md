# ETLayer

**ETLayer is an OTel-native event data plane for product and business events.**

ETLayer receives OpenTelemetry events, applies business-event semantics and policy, preserves policy-clean replayable evidence, and projects events into analytics and experimentation systems without coupling application code to a vendor.

> Emit once. Own the event. Route and replay it anywhere.

## Why ETLayer?

Product events often start life inside a vendor SDK. That makes the analytics backend part of the application contract and makes migrations, replay, governance, multi-destination routing, and trustworthy automation harder than they should be.

ETLayer keeps those concerns separate.

~~~text
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
~~~

ETLayer is not an analytics UI and is not intended to replace OpenTelemetry.

OpenTelemetry owns instrumentation and transport where practical. ETLayer focuses on product/business event semantics, governance, durable evidence, project isolation, and vendor-neutral projection after ingestion.

## Core semantic model

ETLayer deliberately keeps these dimensions separate:

~~~text
subject     - who the product journey/event is about
actor       - who or what directly acted
delegation  - on whose behalf / through whom
producer    - which authenticated producer supplied the evidence
authority   - what that producer is allowed to assert
provenance  - trusted identity established at the ingest boundary
project     - trusted tenant/project scope
causation   - direct causal predecessor
correlation - larger activity/journey grouping
~~~

Important invariants include:

~~~text
subject != actor
producer != actor
authority != actor
payload claim != trusted provenance
payload project != trusted project
valid contract != allowed authority
~~~

## Current implementation

The reference implementation targets Cloudflare:

~~~text
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
~~~

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

~~~text
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

VS12 External Integration Contract            complete
VS13 Versioned Encryption Roots & Safe Rotation complete
VS14 First-class Quarantine                    complete
VS15 Append-only Control-plane Audit Log          complete
VS16 Contract Compatibility Checker               complete
VS17 Historical Contract Plan                     in progress
~~~

The current live acceptance suite re-proves VS8 -> VS15 serially in an isolated Cloudflare CI environment.

See:

- [Roadmap](docs/roadmap.md)
- [Post-VS11 Architecture Review](docs/reviews/post-vs11-architecture-review.md)
- [Post-VS12 Architecture Review](docs/reviews/post-vs12-architecture-review.md)
- [VS12: External Integration Contract](docs/vertical-slices/vs12-external-integration-contract.md)
- [VS13: Versioned Encryption Roots & Safe Rotation](docs/vertical-slices/vs13-encryption-root-rotation.md)
- [VS14: First-class Quarantine](docs/vertical-slices/vs14-quarantine.md)
- [VS15: Append-only Control-plane Audit Log](docs/vertical-slices/vs15-control-plane-audit.md)
- [VS16: Contract Compatibility Checker](docs/vertical-slices/vs16-contract-compatibility.md)
- [VS17: Contract Plan Against Historical Events](docs/vertical-slices/vs17-contract-plan.md)
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

## Product contract

**VS12 - External Integration Contract is complete.**

A clean external application can now integrate using:

~~~text
documented /api/v1 product endpoints
issued project credentials
standard OTLP
public event status
~~~

without knowledge of R2 paths, Wrangler, registry internals, /_mgmt or /_ops diagnostic surfaces, or ETLayer implementation modules.

Secret-bearing onboarding is retry-safe through required idempotency and a bounded encrypted response replay contract. The full VS8 -> VS12 live suite and independent PostHog provider verification passed.

## Encryption root lifecycle

**VS13 - Versioned Encryption Roots & Safe Rotation is complete and live-proven.**

ETLayer now treats persisted `keyVersion` as a real decryptability contract:

~~~text
read historical v1 + v2
new writes use explicit active version
long-lived destination secrets rewrap append-only
bounded idempotency capsules drain by expiry
old roots retire only after machine-verifiable readiness
~~~

Destination and idempotency roots remain separate security domains. VS13 does not introduce a generic KMS abstraction and does not change the public `/api/v1` contract.

The full VS8 -> VS13 Cloudflare acceptance suite passed. The shared CI archive still contains historical V1 records, so an old root is not declared retirement-safe merely because current writes use V2.

## Stability

ETLayer is still pre-stable.

The data-plane foundation is proven through VS11, the external product contract through VS12, versioned encryption-root lifecycle through VS13, explicit ALLOW / QUARANTINE / BLOCK trust outcomes through VS14, and append-only internal control-plane audit evidence through VS15, and deterministic contract compatibility checks through VS16. ETLayer remains pre-stable while broader hosted-product and operational surfaces are still evolving.

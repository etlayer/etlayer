# Technical Capability Gap Analysis and Trust Governance Priorities

Status: strategic technical review, not a committed implementation sequence.

Review snapshot: 2026-09-24.

This review identifies technical and product capabilities that strengthen ETLayer's existing architecture and trust model.

The purpose is to capture missing or underdeveloped capabilities without coupling the roadmap to any vendor, product, or market category.

The working thesis remains:

~~~text
producer claim
  -> authenticated producer
  -> trusted provenance
  -> semantic authority
  -> contract / policy
  -> trusted canonical event
  -> immutable decision lineage
  -> destination projection
  -> delivery
~~~

## Classification

Format:

~~~text
[PRIORITY][EFFORT]-[HORIZON]-[DOMAIN]
~~~

Example:

~~~text
A2-NOW-GOV/DX
~~~

means:

- A: core / must-have;
- 2: medium implementation effort;
- NOW: nearest product cycle;
- GOV/DX: Governance + Developer Experience.

### Priority

- A - Core / must-have. A fundamental ETLayer capability or a strong part of its differentiation.
- B - Important. Materially improves adoption, operator experience, developer experience, or enterprise value.
- C - Optional. Useful, but not required for a strong ETLayer product.

### Effort

- 1 - Small. Mostly reuses existing primitives; likely one compact vertical slice.
- 2 - Medium. Introduces a new resource, workflow, or several coordinated API/runtime changes.
- 3 - Large. Introduces a substantial subsystem, data model, or infrastructure layer.

Effort is relative to the current ETLayer architecture.

### Horizon

- NOW - nearest product cycle;
- NEXT - next wave after NOW;
- LATER - strategically useful but not near-term;
- SKIP - intentionally outside the current product thesis.

### Domains

- PRDT - Product capabilities and product behavior.
- DX - Developer Experience: SDK, CLI, code generation, local integration, and CI workflows.
- INF - Infrastructure: runtime, queues, deployment, scaling, and infrastructure primitives.
- GOV - Governance: contracts, policies, ownership, lifecycle, approvals, and compliance rules.
- SEC - Security: authentication, authorization, trust boundaries, signing, and secrets.
- DATA - Data: storage, indexing, querying, retention, and analytical data infrastructure.
- OPS - Operations / Reliability / Observability: monitoring, retries, failures, debugging, and operational visibility.
- API - Public API / Integrations: public interfaces, destinations, webhooks, and external integrations.
- AI - Agents / MCP / AI-native capabilities: agent access, MCP, and agent governance.
- UX - Human-facing User Experience / User Interface.

## Capability gap matrix

| Code | Capability | Why it matters |
|---|---|---|
| A1-NOW-GOV/OPS | Quarantine | Separate recoverable invalid data from semantic trust rejection |
| A1-NOW-GOV/SEC | Control-plane audit log | Make policy and configuration changes attributable and append-only |
| A2-NOW-GOV/DX | Contract compatibility checker | Detect backward/forward/breaking schema changes before publish |
| A2-NOW-GOV/DX | `etlayer plan` | Simulate contract/policy changes against historical events before publish |
| A2-NOW-OPS/UX | Delivery + Attempt resources | Make retries, failures, debugging, and replay first-class |
| A2-NOW-GOV/DX | Governance-as-Code | Keep contracts and policies versionable, reviewable, and CI-friendly |
| A2-NOW-GOV/PRDT | Contract lifecycle | Draft -> Review -> Published -> Deprecated -> Retired |
| A1-NOW-GOV/PRDT | Ownership metadata | Attach team/domain ownership early, before retrofitting becomes expensive |
| A2-NOW-OPS/GOV | Governance metrics | Measure accept/quarantine/block/violation/delivery health |
| A2-NEXT-GOV/PRDT | Environment promotion | Promote validated policy from dev -> staging -> production |
| A2-NEXT-GOV/SEC | Destination-specific privacy/consent policy | Keep canonical facts immutable while projecting only allowed fields per destination |
| A2-NEXT-DX/API | Typed SDK/code generation | Move contract errors closer to compile time and constrain producer capabilities |
| A2-NEXT-AI/GOV | MCP control plane | Make ETLayer safely operable by agents through the same product model |
| A2-NEXT-AI/SEC | Scoped MCP permissions | Prevent agents from implicitly gaining full workspace authority |
| B2-NEXT-DX/UX | Live contract debugger | Let developers inspect dev/staging events against current contracts and policies |
| B2-NEXT-GOV/DX | Contract inference from observed traffic | Bootstrap existing applications without manually describing every event |
| B1-NEXT-GOV/OPS | Violation ownership and escalation | Turn violations into actionable work rather than passive diagnostics |
| B2-NEXT-PRDT/UX | Event Catalog | Expose events, producers, consumers, contracts, and owners as a navigable model |
| A3-NEXT-GOV/DATA | Consumer impact analysis | Explain what would break before accepting a breaking event-contract change |
| B2-NEXT-OPS/GOV | Correct + Replay | Recover data without mutating the original immutable event |
| A2-NEXT-API/SEC | Signed webhook destination | Provide production-grade generic outbound delivery with replay protection |
| B1-NEXT-OPS/API | Pause / Resume / Abort delivery | Give operators explicit downstream delivery control |
| B1-NEXT-GOV/DATA | Namespaced extensible facets | Extend event context without bloating the canonical envelope |
| B2-NEXT-AI/DX | Semantic contract search | Help people and agents find existing semantics before creating duplicates |
| B3-LATER-DATA/GOV | Typed lineage graph | Model richer dependency and causal relationships when IDs alone are insufficient |
| B3-LATER-UX/DATA | Visual event graph | Useful after ETLayer has trustworthy graph edges |
| B3-LATER-INF/API | Ordering / FIFO guarantees | Useful for specific consumers, but expensive because of head-of-line blocking |
| C3-LATER-PRDT/GOV | Self-service event portal | Potential enterprise capability, not required for the first product |
| C3-LATER-INF/SEC | Arbitrary user JS/Python transforms | Powerful but introduces sandbox, security, and runtime complexity |
| C3-SKIP-PRDT/DATA | Customer 360 / Profiles | ETLayer should not become a customer data platform |
| C3-SKIP-PRDT/API | Reverse ETL / Audiences | Outside the current trust-layer thesis |
| C3-SKIP-PRDT/UX | Funnel / retention analytics | Downstream analytics products should remain consumers |
| C3-SKIP-INF | Build a Kafka-like event backbone | Infrastructure complexity without current differentiation |

## Milestone 1 - Trust Governance

The first milestone derived from this review should strengthen ETLayer's trust model before expanding hosted-product surfaces.

The proposed initial set is:

~~~text
A1-NOW-GOV/OPS
Quarantine
Core - small effort - do now
Governance + Operations / Reliability / Observability

A1-NOW-GOV/SEC
Control-plane Audit Log
Core - small effort - do now
Governance + Security

A2-NOW-GOV/DX
Contract Compatibility Checker
Core - medium effort - do now
Governance + Developer Experience

A2-NOW-GOV/DX
etlayer plan
Core - medium effort - do now
Governance + Developer Experience

A2-NOW-OPS/UX
Delivery + Attempt
Core - medium effort - do now
Operations / Reliability / Observability + User Experience

A2-NOW-GOV/DX
Governance-as-Code
Core - medium effort - do now
Governance + Developer Experience
~~~

These are intentionally capabilities, not assigned VS numbers yet.

Per the roadmap rule, each becomes a numbered vertical slice only after it has:

1. a concrete user or architectural risk;
2. a target invariant;
3. an executable acceptance proof;
4. evidence that it is the smallest useful slice.

## Suggested semantic model

The analysis suggests that ETLayer should converge toward this product vocabulary:

~~~text
Claim
  -> Producer
  -> Trusted Provenance
  -> Semantic Authority
  -> Contract / Policy
  -> ALLOW | QUARANTINE | BLOCK
  -> Canonical Trusted Event
  -> Decision Lineage
  -> Destination Projection
  -> Delivery
  -> Attempt
~~~

This intentionally distinguishes:

- invalid or temporarily unresolved data from unauthorized assertions;
- canonical event truth from destination-specific projections;
- an event from attempts to deliver it;
- runtime event decisions from control-plane configuration changes.

## Product boundary

This review does not change the current non-goals.

ETLayer should not optimize for:

- number of destinations;
- product-analytics dashboards;
- CDP profiles and audiences;
- replacing OTLP;
- becoming a general-purpose event-stream backbone or message broker;
- an agent-specific workflow runtime.

The differentiating center remains the trust transition:

~~~text
producer claim != trusted business fact
~~~

ETLayer should make that transition explicit, inspectable, governable, replayable, and safe to automate.

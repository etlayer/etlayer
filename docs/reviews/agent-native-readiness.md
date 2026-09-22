# Agent-Native Readiness Review

**Status: Architecture review after VS1–VS5.**

## Purpose

This review asks one question:

> If a meaningful share of product and business actions are performed by agents, subagents, services, and tools rather than directly by humans, does ETLayer's current architecture still preserve the right facts?

The review uses ideas raised in `sergii/auditspec` as a **design probe**, not as a normative dependency.

AuditSpec is still a draft. ETLayer does not claim conformance to it, does not depend on its stability, and should not copy its surface syntax mechanically.

The useful method is:

```text
AuditSpec raises a hard accountability question
        |
        v
Does the same problem exist in product/business telemetry?
        |
        +-- no  -> ignore it
        |
        +-- yes -> extract the durable primitive
                  make it vendor-neutral
                  prove it in ETLayer
```

VS5 already validated this approach: the distinction between **analytics subject** and **immediate actor** survives independently of AuditSpec and is useful for agent-native products.

---

## Executive summary

ETLayer is already unusually well-positioned for agent-native telemetry because VS1–VS5 established five durable boundaries:

```text
VS1  preserve before project
VS2  one canonical event -> independent destinations
VS3  executable semantic contracts
VS4  privacy before routing
VS5  subject != actor; delegation is explicit
```

The architecture does **not** need an "agent mode" or a proprietary agent SDK.

The strongest existing primitives are already general enough:

- stable event identity;
- canonical preservation;
- correlation and causation;
- executable contracts;
- producer/authority context;
- privacy classification;
- analytics subject;
- immediate actor;
- delegation;
- session;
- agent turn/tool-call correlation;
- deterministic replay.

The most important unresolved agent-native boundary is:

```text
producer != actor != authority
```

VS5 solved:

```text
actor != subject
```

but ETLayer still needs a stronger trust model for statements such as:

```text
etlayer.producer.kind = backend
etlayer.authority.kind = business_state
```

Today these semantics are represented in the event payload. In a hostile or merely buggy producer environment, a producer can claim an authority level that ETLayer did not independently establish.

That is acceptable for the current reference fixture. It is not a sufficient long-term trust boundary for agent-native systems.

The recommended next architectural target is therefore **trusted provenance and authority**, not another destination and not a larger identity graph.

---

# The agent-native semantic model

A useful long-term mental model is:

```text
What happened?
    event

Who is the product event about?
    subject

Who directly performed the action?
    actor

Who authorized / delegated that actor?
    delegation

Who is trusted to assert that the event happened?
    authority

Which authenticated producer supplied the evidence?
    provenance

What caused it?
    causation

Which larger activity groups it?
    correlation

Where in an agent execution did it happen?
    session / turn / tool-call
```

These concepts must not be collapsed.

Example:

```text
User asks an agent to update project settings.

subject:
  user/usr_42

actor:
  agent/agent_hanna

delegation:
  on_behalf_of -> user/usr_42

producer:
  agent-runtime/backend

authority for "tool call attempted":
  agent runtime / tool executor

authority for "project settings changed":
  project backend / system of record
```

The last two events may belong to the same causal chain while having different authorities.

That distinction is fundamental.

---

# Novelty lens

Traditional product analytics often assumes:

```text
user == actor == analytics identity
```

Agent-native applications invalidate that assumption.

ETLayer now supports:

```text
analytics subject          accountability
-----------------          -------------------------
user.id                    actor.type
anonymous.id               actor.id
account.id                 delegation
session.id                 agent.turn.id
                           agent.tool_call.id

           common causal context
           ---------------------
           correlation.id
           causation.id
```

This gives ETLayer a potentially differentiated position:

> preserve product analytics continuity without erasing who or what actually performed the action.

That is broader than "analytics for agents" and more durable than framework-specific telemetry.

A possible internal product thesis is:

> A semantic event layer for humans, services, and agents.

This is an architectural thesis, not yet a recommendation to change the public landing-page message.

---

# Cross-cutting findings

## F1 — Subject and actor must remain separate

**Status: solved in VS5.**

A user may remain the analytics subject while an agent is the immediate actor.

ETLayer must never infer:

```text
distinct_id=user
therefore actor=user
```

Live VS5 evidence proved that PostHog can remain user-centric while ETLayer preserves:

- direct agent actor;
- child-agent actor;
- ordered delegation;
- one continuous user person.

### Keep

The VS5 model:

```text
subject
actor
delegation
attribution
```

### Do not add

Framework-shaped core fields such as:

```text
langchain_agent_id
openai_assistant_id
crew_id
autogen_role
```

Those can exist as ordinary context if needed, but must not define ETLayer semantics.

---

## F2 — Producer, actor, and authority are different things

**Status: important gap.**

An event can have:

```text
producer = backend service
actor    = agent
subject  = user
```

and the backend may or may not be authoritative for the event being asserted.

Current contracts include values such as:

```text
etlayer.producer.kind
etlayer.authority.kind
```

but these are currently event attributes.

Long-term, trusted provenance must come from the authenticated ingest boundary, not solely from producer-supplied claims.

### Required direction

The gateway should eventually attach an immutable trusted envelope derived from:

- ingest credential;
- authenticated connection;
- configured producer registration;
- deployment/resource context;
- trusted ETLayer processing metadata.

Conceptually:

```text
trusted provenance
  principal
  producer kind
  ingest credential / registration
  received_at
  trust level

event assertion
  event name
  actor
  subject
  delegation
  claimed authority

policy
  may this trusted producer assert this event/authority combination?
```

A browser must not be able to obtain backend authority merely by sending:

```text
etlayer.producer.kind=backend
etlayer.authority.kind=business_state
```

### Candidate next slice

**Trusted Provenance & Authority**

This is the strongest candidate for the next vertical slice.

---

## F3 — An agent action is not automatically a business outcome

**Status: needs explicit architectural wording.**

These are different events:

```text
agent.tool.call
project.settings.updated
```

The first says an agent/tool action occurred.

The second says the system of record committed or observed a business state transition.

Even when:

```text
agent.tool.call
      |
      v causation
project.settings.updated
```

ETLayer must not reinterpret the first as proof of the second.

### Keep

The existing authority distinction between interaction and business-state events.

### Clarify

Authority belongs to the fact being asserted, not to the prestige of the actor.

An agent can be the immediate actor and still not be the authority for the resulting business fact.

---

## F4 — Replay must never mean re-execute the original action

**Status: architecture is safe; wording should remain explicit.**

ETLayer replay currently means:

```text
canonical event
   |
re-run ETLayer policy/projection
   |
destination delivery
```

For agent events this must **never** become:

```text
re-run tool call
re-run agent turn
repeat side effect
```

### Keep

Replay as projection/delivery replay only.

### Clarify

An `agent.tool.call` event can be replayed to PostHog, Statsig, a warehouse, or an audit sink.

Its original tool side effect is historical evidence and is not executed again.

### Explicit non-goal

ETLayer is not an agent workflow engine or side-effect re-execution system.

---

## F5 — "Canonical" means policy-clean canonical, not raw-unfiltered bytes

**Status: terminology should be precise.**

VS4 deliberately removes secrets before Queue/R2.

Therefore the durable store is not literally lossless relative to the incoming request.

The stronger and more accurate invariant is:

> ETLayer preserves a replayable canonical event after mandatory ingest policy.

### Keep

Secret scrubbing before durable storage.

### Clarify

"Lossless" means lossless with respect to the **accepted policy-clean event model**, not with respect to rejected secret material.

This distinction becomes more important with agent payloads because prompts, tool arguments, headers, credentials, and tool results may contain high-risk content.

---

## F6 — Agent content is a larger privacy surface than agent identity

**Status: future work; do not solve with heuristics yet.**

VS4 handles key-based classifications well for known fields.

Agent systems create new high-risk content categories:

```text
prompt / instructions
tool arguments
tool results
retrieved documents
memory/context
HTTP headers
credentials accidentally embedded in text
model output
```

ETLayer should not start collecting these merely because they are available.

### Keep

"Wide, but intentional."

### Add later

If ETLayer introduces content-bearing agent fields, define them explicitly and decide for each:

- never ingest;
- ingest then redact;
- canonical only;
- destination-eligible;
- hash/tokenize;
- size limits;
- retention class.

### Explicit non-goal

No generic "capture the whole prompt/tool payload" primitive.

No ML PII detector in the core until a proven requirement exists.

---

## F7 — Causality is already valuable for agents, but fan-in should not be invented early

**Status: current primitives are sufficient for the proven cases.**

VS1–VS5 use:

```text
correlation.id
causation.id
session.id
agent.turn.id
agent.tool_call.id
```

This naturally models:

```text
user request
  -> agent turn
  -> tool call
  -> subagent call
  -> business event
```

### Keep

One direct `causation.id` where the domain has one direct cause.

### Add later only if proven

Some workflows may have fan-in:

```text
event C caused by A + B
```

If real examples demand it, ETLayer can add a links/multi-parent concept.

Do not introduce a generalized causal graph engine before that requirement exists.

---

## F8 — Destination projection should eventually describe semantic loss

**Status: useful future hardening.**

Product analytics, experimentation, warehouse, and audit destinations do not have the same semantic capacity.

For example:

```text
ETLayer:
  subject=user
  actor=agent
  delegation=child -> parent -> user

PostHog:
  distinct_id=user
  actor/delegation as properties

Statsig:
  userID=user
  agentID as custom ID
  additional semantics in metadata
```

The projection is intentionally lossy.

### Keep

Canonical ETLayer semantics remain destination-neutral.

### Add later

A small adapter capability/projection manifest could state which semantic dimensions are:

- native;
- encoded as properties/metadata;
- omitted;
- unsupported.

This would make semantic loss explicit without forcing a universal destination schema.

---

## F9 — Prefer OpenTelemetry conventions when they exist

**Status: permanent principle.**

Agent-native telemetry will tempt ETLayer to invent many fields.

Do not.

Before adding model/provider/token/tool execution fields to ETLayer core, evaluate whether OpenTelemetry already defines an appropriate semantic convention.

ETLayer should own only the missing product/business semantics:

- subject;
- authority;
- product delegation meaning where upstream lacks it;
- governance;
- privacy;
- replay;
- destination projection.

If upstream conventions become sufficient, migrate and delete ETLayer-specific conventions.

---

## F10 — ID prefixes are conventions, never semantics

**Status: solved in VS5; keep explicit.**

These are convenient:

```text
user_
anon_
agent_
session_
turn_
call_
```

but ETLayer must never determine type from them.

Correct:

```text
actor.type = agent
actor.id   = runtime-123
```

Incorrect:

```text
id startsWith("agent_") => agent
```

This matters when IDs come from external systems.

---

# VS1 review — Durable preservation and replay

## Keep

- OTLP as the producer boundary.
- Stable logical event IDs.
- At-least-once internal delivery.
- Preserve before project.
- Destination-independent producer instrumentation.
- Replay as a first-class architectural capability.
- Correlation/causation as replayable event context.

These properties become **more** important when agent/tool execution creates longer causal chains and more asynchronous activity.

## Clarify

### Replay semantics

Replay re-runs ETLayer policy/projection/delivery. It never re-runs the historical agent action or tool side effect.

### Canonical semantics

The durable event is canonical **after mandatory ingest policy**.

Secret material removed at ingest is intentionally not replayable.

### Producer is not actor

A backend/worker/agent-runtime may transport an event whose immediate actor is a different principal.

## Add later

- trusted ingest provenance derived from authentication;
- producer registration / trusted producer kind;
- policy version metadata sufficient to explain how an event was accepted;
- optional source-runtime identity where it materially improves provenance.

## Explicit non-goals

- agent orchestration;
- tool execution;
- side-effect replay;
- capturing arbitrary prompts/tool payloads;
- global ordering.

---

# VS2 review — Multi-destination routing

## Keep

- canonical event independent from destination projections;
- independent destination outcomes;
- destination-specific delivery state;
- targeted replay;
- producer ignorance of connected vendors.

This is exactly what agent-native systems need: product analytics, experimentation, warehouse, and future audit/security consumers can receive different projections from one semantic event.

## Clarify

### Analytics destination != audit destination

A product analytics sink may intentionally receive:

```text
subject=user
actor=agent as properties
```

while a future audit sink may preserve richer actor/delegation/provenance semantics natively.

Neither destination should redefine the canonical event.

### Destination success does not prove business success

```text
Statsig exported
PostHog exported
```

means projection delivery succeeded, not that an agent action or business side effect succeeded.

## Add later

- projection capability manifest;
- event-class / policy-based routing if a real audit/security destination requires it;
- destination-specific privacy policies only when the global policy is insufficient.

## Explicit non-goals

- vendor-specific identity semantics in producers;
- treating a product analytics system as the canonical accountability store;
- destination-driven event vocabulary.

---

# VS3 review — Event contracts and governance

## Keep

- executable contracts;
- versioned event semantics;
- blocked events remain canonically inspectable;
- machine-readable validation evidence;
- deterministic revalidation.

Agent-generated events especially need contracts because high event volume makes informal conventions dangerous.

## Clarify

### Shape validation is not authority validation

A structurally valid:

```text
agent.tool.call
```

does not prove the producer had the right to assert it.

A structurally valid:

```text
payment.completed
```

does not make an agent authoritative for payment completion.

### Cross-field semantics matter

VS5 already introduced rules such as:

```text
actor.type=agent
requires actor.id

delegation entry
requires relationship + principal type + principal id
```

The next generation of contracts may need trusted-envelope and cross-field rules.

## Add later

Only when proven:

- cross-field equality constraints;
- actor/event compatibility;
- authority/provenance requirements;
- limited semantic predicates;
- contract migration tooling.

## Explicit non-goals

- arbitrary policy programming language;
- general workflow validation;
- model-specific agent schemas;
- a remote schema-registry dependency in the hot path.

---

# VS4 review — Privacy policy

## Keep

The two privacy stages are strong:

```text
secret
  -> drop before Queue/R2

direct identifier
  -> optionally canonical
  -> drop before analytics routing
```

This is a good foundation for agent-native data because it distinguishes "must never persist" from "may be canonical but not analytics-visible."

## Clarify

### Agent identity is not the largest privacy risk

```text
actor.id=agent_hanna
```

is generally easier to govern than unbounded:

```text
prompt
tool arguments
tool result
retrieved document
memory
```

Do not let agent observability become an excuse for broad content capture.

### Delegation can itself be sensitive

Delegation principal IDs and impersonation/assumed-role context can reveal organizational relationships.

They need explicit classification and destination policy.

## Add later

If content fields are introduced:

- explicit field vocabulary;
- strict size limits;
- allowlist/default-deny posture;
- redaction or hashing rules where justified;
- retention-class metadata;
- tests proving secrets cannot leak through nested structures.

## Explicit non-goals

- generic prompt archive;
- arbitrary tool-result archive;
- secret recovery;
- ML-based PII detection as core correctness logic.

---

# VS5 review — Identity, actor, delegation, attribution

## Keep

This is the strongest agent-native slice so far.

Preserve:

```text
subject
actor
delegation
attribution
session
turn
tool call
```

The live proof is particularly valuable because it demonstrated:

```text
one user analytics person
+
different immediate agent actors
+
ordered delegation
```

without producer-side PostHog/Statsig identity calls.

## Clarify

### Delegation is currently an asserted semantic fact

ETLayer preserves:

```text
agent_child
  delegated_by -> agent_parent
  on_behalf_of -> user
```

but preservation is not the same as independent attestation.

Trusted provenance/authority is the next boundary.

### Actor types beyond agent remain semantic primitives

Current actor types include:

- anonymous;
- user;
- agent;
- service;
- api_key;
- system;
- automation.

Not all need separate vertical slices now.

### Attribution and delegation are different

```text
attribution
  where the product journey came from

delegation
  why this actor was acting for another principal
```

Do not merge them into a generic "context" object.

## Add later

Only as real products require them:

- service/API-key/system acceptance cases;
- `impersonation` acceptance semantics;
- `assumed_role` acceptance semantics;
- richer agent execution correlation using upstream OTel conventions;
- explicit mapping rules for audit/security destinations.

## Explicit non-goals

- identity graph;
- probabilistic actor matching;
- framework-specific agent identity;
- automatic delegation inference from ID prefixes;
- retroactive rewrite of canonical history.

---

# The highest-value next question

The review's strongest unresolved invariant is:

```text
Can ETLayer trust who is asserting the event?
```

Today VS3 can answer:

```text
Is this event structurally and semantically valid?
```

VS5 can answer:

```text
Who is the analytics subject?
Who is the immediate actor?
What delegation was asserted?
```

The missing question is:

```text
Which authenticated producer supplied this evidence,
and is that producer allowed to assert this authority?
```

This suggests a future vertical slice such as:

# Candidate VS6 — Trusted Provenance & Authority

Not implementation yet. Proposed proof:

```text
browser credential
  sends account.created
  claims producer=backend
  claims authority=business_state
        |
        v
ETLayer trusted ingest envelope says browser
        |
        v
BLOCK
```

versus:

```text
registered backend credential
  emits account.created
        |
trusted ingest envelope says backend/system-of-record
        |
contract + authority policy
        |
ALLOW
```

For an agent:

```text
producer   = authenticated agent runtime
actor      = agent_hanna
subject    = usr_42
delegation = on_behalf_of -> usr_42
authority  = allowed for "tool call occurred"

but

same agent runtime
claims payment.completed
authority = payment system-of-record
        |
        v
BLOCK unless trusted provenance/policy allows it
```

Acceptance should prove:

1. trusted producer metadata is stamped by ETLayer, not accepted from arbitrary payload fields;
2. producer claims cannot override trusted metadata;
3. contracts/policy can require a trusted producer/authority combination;
4. canonical replay preserves the original trusted provenance;
5. revalidation can apply current policy without rewriting historical provenance;
6. destination projections may expose a safe subset of provenance;
7. no agent framework is required.

---

# What not to build next

This review does **not** justify:

- an identity graph;
- a general agent runtime;
- a workflow engine;
- a prompt warehouse;
- a universal audit product;
- a custom tracing standard;
- framework integrations for every agent SDK;
- a causal graph database;
- more destinations merely to increase connector count.

The architecture is strongest when ETLayer owns a small set of durable semantics and delegates transport/runtime telemetry to OpenTelemetry.

---

# Recommended invariant set

The following invariants are worth treating as architectural laws:

```text
1. The application owns event meaning.
2. OpenTelemetry owns transport/runtime telemetry where possible.
3. ETLayer preserves before destination projection.
4. Mandatory ingest privacy runs before durable canonical storage.
5. Canonical means policy-clean canonical.
6. Subject and actor are independent.
7. Delegation never overwrites the immediate actor.
8. Producer and actor are independent.
9. Authority is about the asserted fact, not the actor's identity.
10. Trusted provenance must eventually come from the ingest boundary.
11. Replay re-projects evidence; it never repeats historical side effects.
12. Destinations are lossy projections, never semantic authorities.
13. IDs never imply type by prefix.
14. Agent/framework-specific concepts stay out of core unless they survive framework changes.
15. Delete ETLayer conventions when upstream OpenTelemetry semantics become sufficient.
```

---

# Decision

VS1–VS5 do **not** need an agent-specific rewrite.

The architecture already supports an agent-native direction because its best abstractions are not agent-specific.

The review recommends:

```text
Keep:
  preservation
  replay
  contracts
  privacy
  subject/actor separation
  delegation
  causality

Clarify:
  policy-clean canonical semantics
  replay != side-effect execution
  agent action != business outcome
  producer != actor != authority

Add later:
  trusted provenance/authority
  projection capability metadata
  narrowly-scoped content privacy rules
  richer causal links only if proven necessary

Explicit non-goals:
  identity graph
  agent runtime
  prompt warehouse
  framework-specific core schema
  generalized causal/workflow engine
```

The highest-value next architectural experiment is trusted provenance and authority attestation.

That result comes from the agent-native review itself; it is not a dependency on AuditSpec becoming stable or leaving draft status.

# Agent-native readiness review

**Status: Architecture review after VS5. No VS6 is selected by this document.**

## Why this review exists

ETLayer now has five live-proven vertical slices:

```text
VS1  durable preservation + replay
VS2  multi-destination routing + failure isolation
VS3  executable event contracts + governance
VS4  privacy classification + enforcement
VS5  identity + actor + delegation + attribution
```

VS5 exposed a broader architectural fact: product events are no longer necessarily produced or caused only by a browser, backend service, or human user.

A modern product chain can look like:

```text
human request
   ↓
agent turn
   ↓
tool call
   ↓
subagent
   ↓
second tool call
   ↓
business state change
   ↓
product/business event
```

The system still needs product analytics continuity, but accountability cannot collapse every participant into the user.

This review uses ideas raised by the AuditSpec draft as a **design probe**, not as an ETLayer dependency, conformance target, or normative source.

AuditSpec may change or remain a draft. ETLayer should keep only primitives that remain independently useful.

## Review rule

For every candidate idea, ask:

```text
Does ETLayer need this even if AuditSpec disappears tomorrow?
```

If the answer is no, it does not belong in ETLayer core.

## The most important finding

Agent-native product telemetry needs more than one identity dimension.

VS5 now separates:

```text
analytics subject   who the product event belongs to
immediate actor     who actually performed the action
delegation          on whose behalf / through which chain
attribution         where the product journey came from
```

Example:

```text
user asks agent to modify a project

analytics subject = user/usr_42
actor             = agent/agent_hanna
delegation        = on_behalf_of -> user/usr_42
```

This lets PostHog or Statsig stay user-centric while ETLayer preserves who actually acted.

This principle is independently useful and should remain even if all current agent frameworks and AuditSpec disappear.

---

# Cross-cutting agent-native questions

The following questions are more durable than any particular framework:

1. Who performed the action?
2. Who is the analytics/business subject?
3. Was the actor delegated authority by another principal?
4. Who is authoritative for asserting that the event happened?
5. What evidence supports that assertion?
6. What directly caused the event?
7. Where did the interaction originate?
8. What sensitive material must be removed before durable storage?
9. What does replay mean for an event describing a real side effect?
10. Was the action authorized, and separately, did execution succeed?

ETLayer already answers some of these well. Others are currently implicit or overloaded.

---

# VS1 — durable preservation and replay

## Keep

- canonical immutable event storage;
- stable logical event identity across retries;
- projection replay from canonical storage.

These become more valuable with agents because one logical action may feed analytics, warehouse, audit/evidence, evaluation, security, or billing projections.

## Clarify

### Replay means telemetry projection replay only

ETLayer replay MUST NOT mean:

```text
re-run the agent
re-run the tool
repeat the command
repeat the business mutation
repeat an external side effect
```

The invariant should be explicit:

> ETLayer replays evidence/projections of a logical event. It does not re-execute the producer, actor, command, tool, or business side effect that originally caused the event.

### Occurrence time vs receipt time

Agent chains can be queued, retried, observed asynchronously, or delivered late.

Document clearly:

```text
occurred time  when the logical event happened
received time  when ETLayer accepted it
```

Do not infer causal order from timestamps when stronger causality exists.

## Add later

- explicit provenance/evidence references;
- optional content digests for externally retained evidence;
- stronger source semantics.

## Explicit non-goal

ETLayer is not an agent command bus, task runner, workflow engine, or side-effect replay engine.

---

# VS2 — multi-destination routing

## Keep

- independent destination outcomes;
- destination-specific projections;
- destination-aware replay/idempotency.

## Clarify

### Destination acceptance is not business authority

A successful PostHog or Statsig response means:

```text
projection accepted
```

It does not prove the underlying business assertion was authoritative.

### Event truth and delivery state remain separate

```text
event valid
privacy applied
identity resolved
delivery failed
```

is different from:

```text
event invalid
delivery never attempted
```

## Add later

Destination capability metadata may eventually be useful:

```text
analytics
warehouse
audit
evaluation
security
```

Do not build a routing DSL until a real vertical slice needs it.

## Explicit non-goal

ETLayer does not become an agent orchestration framework merely because agent events flow through it.

---

# VS3 — contracts and semantic governance

## Keep

- executable versioned contracts;
- preserve-before-policy;
- machine-readable validation evidence.

## Clarify

### Structural validation is not enough

Current contract vocabulary handles:

```text
required
type
const
forbidden
```

Agent/delegation semantics introduce cross-field invariants such as:

```text
delegation.0.principal.id == user.id

actor.type == agent
  implies actor.id exists

delegated_by -> agent
  references the expected parent actor
```

These relationships should not be silently inferred.

### Producer, actor, and authority are different

Possible event:

```text
producer = backend service
actor    = agent
authority for account.created = backend state transition
```

Who serialized the event, who acted, and who can truthfully assert the state are separate dimensions.

## Add later

A deliberately small cross-field semantic rule vocabulary may be needed.

Do not introduce a general expression language prematurely.

## Explicit non-goal

ETLayer is not a universal schema registry or arbitrary policy engine.

---

# VS4 — privacy

## Keep

### Secret removal before durable storage

This becomes even more important in agent systems because prompts/tool payloads can contain:

```text
API keys
bearer tokens
cookies
private repository content
personal data
credentials
```

### Separate canonical and destination privacy

Some fields can be canonical while being withheld from analytics.

## Clarify

### Key-name classification is not full agent-payload safety

Fields like:

```text
tool.input
prompt
agent.output
request.body
```

can contain secrets even when the key itself is not secret-like.

### Raw prompts/tool payloads should not be core telemetry by default

Prefer:

```text
digest
reference
small policy-controlled preview
explicitly classified metadata
```

over automatically storing full prompts, tool inputs, and outputs.

## Add later

- content-bearing field classes;
- digest/reference primitives;
- explicit redaction evidence;
- allowlist-based previews.

## Explicit non-goal

- universal ML PII detection;
- prompt warehouse;
- full DLP product.

---

# VS5 — identity, actor, delegation, attribution

## Keep

VS5 contains the strongest agent-native semantic improvement so far.

Keep permanently:

- analytics subject != immediate actor;
- explicit actor type;
- ordered delegation;
- stable session/turn/tool-call correlation;
- anonymous -> identified continuity;
- vendor-neutral identity projection.

Do not infer actor semantics from ID prefixes.

```text
agent_
user_
anon_
```

are conventions only.

## Clarify

### ETLayer subject means analytics subject

This is not automatically the same as a generic affected domain subject.

Before the public semantic contract freezes, consistently call it:

```text
analytics subject
```

and consider whether durable evidence should eventually use a more explicit name such as:

```text
analyticsSubject
```

### AuditSpec influence is non-normative

The useful questions around actor/delegation came from the AuditSpec draft, but ETLayer owns its own vocabulary and semantics.

ETLayer must not claim AuditSpec conformance merely because names overlap.

### Agent actor must never be normalized away

The live VS5 proof now protects:

```text
actor = agent
analytics subject = user
```

for both direct agent and subagent chains.

## Add later

Additional actor types only when a real slice needs them:

```text
service
api_key
system
automation
```

## Explicit non-goal

- general identity graph;
- probabilistic matching;
- agent runtime registry.

---

# Cross-cutting finding — authority and evidence

This is the largest remaining semantic gap found by the review.

Consider:

```text
agent says: "I updated the file"

GitHub API says: commit created

runtime trace says: tool request completed

filesystem watcher says: file changed
```

These observations are related, but they are not equally authoritative for the same claim.

A future ETLayer model may need to distinguish:

```text
assertion
authority
evidence
trust
```

without turning ETLayer into an audit system.

The independent ETLayer question is:

> Can downstream consumers tell whether a product/business event was asserted by the system that actually enforced the state change, by the actor itself, or by a derived observer?

This matters greatly for agent-generated events.

## Current ambiguity

ETLayer already has:

```text
etlayer.authority.kind = interaction | business_state
```

That is useful domain semantics, but it is not obviously the same dimension as evidence trust.

Do not overload one field with both meanings.

---

# Cross-cutting finding — authorization vs execution

Agent workflows often look like:

```text
agent requests action
user approves
policy allows
tool executes
execution fails
```

These are different facts.

Do not collapse:

```text
authorized
succeeded
```

into one status.

ETLayer does not need a full authorization framework now, but future event semantics may need separate:

```text
authorization decision
execution result
approval principal
```

when a concrete product slice requires them.

---

# Cross-cutting finding — causality

ETLayer already has strong primitives:

```text
correlation.id
causation.id
trace/span context
session.id
agent.turn.id
agent.tool_call.id
```

Keep the distinction:

```text
trace/span       technical execution path
causation.id     logical product/business cause
correlation.id   broader workflow/journey
```

Do not infer causal order from timestamps alone.

Only if real scenarios require it, consider:

- explicit parent event ID;
- multiple evidence references;
- bounded stream ordering.

Do not build a global event-DAG engine preemptively.

---

# Cross-cutting finding — origin and producer

Agent-native telemetry benefits from distinguishing:

```text
producer   software component that constructed the event
origin     where the interaction entered/occurred
actor      who performed the action
subject    who analytics belongs to
authority  who can truthfully assert the state
```

Example:

```text
origin.surface = mcp
producer       = github-tool-adapter
actor          = agent_child
subject        = user/usr_42
authority      = GitHub service for commit-created
```

ETLayer has pieces of this model but not a formalized complete vocabulary.

This is a future design area, not a reason to block VS1-VS5.

---

# Novelty test

ETLayer's differentiated value is not:

```text
another agent observability product
another analytics SDK
another audit log
another OpenTelemetry collector
```

A stronger architectural identity is:

> A semantic event layer that can preserve product analytics continuity while retaining who actually acted, how an action was delegated, why an assertion is trusted, what caused it, what privacy policy applied, and how the same canonical event was projected downstream.

The most interesting agent-native properties are:

1. dual identity truth — analytics subject and accountable actor;
2. delegation continuity — agent/subagent responsibility without losing the user journey;
3. authority/evidence separation — self-report is not automatically business truth;
4. side-effect-safe replay — replay projection, never action execution;
5. privacy before persistence — especially for agent/tool payloads;
6. semantic governance — contract rules before downstream contamination;
7. vendor-neutral projection — producer code contains no vendor-specific agent identity logic.

These remain useful even if today's agent frameworks disappear.

---

# Scope guardrails

Do not turn ETLayer into:

- an agent runtime;
- an MCP gateway;
- an agent orchestration platform;
- an approval workflow engine;
- a SIEM;
- a full audit-log product;
- a general provenance graph database;
- an identity graph;
- a prompt warehouse;
- a universal policy engine.

ETLayer should own semantic event normalization, governance, privacy, durable evidence, and projection.

It should integrate with systems that own execution, authorization, audit retention, and orchestration.

---

# Findings by disposition

## Keep

- canonical immutable events;
- stable logical event identity;
- projection replay;
- destination isolation;
- executable versioned contracts;
- preserve-before-policy;
- ingest secret scrubbing;
- destination privacy projection;
- analytics subject / actor separation;
- explicit actor type;
- ordered delegation;
- attribution continuity;
- correlation/causation;
- agent turn/tool-call correlation;
- vendor-neutral destination adapters.

## Clarify now

- replay means projection replay only;
- occurred time vs ETLayer receipt time;
- subject means analytics subject in identity evidence;
- producer vs actor vs authority;
- authority domain vs evidence trust;
- destination acceptance is delivery evidence, not business authority;
- AuditSpec is inspiration, not dependency or conformance.

## Add later when proven by a slice

- cross-field semantic contract constraints;
- authority/evidence/trust model;
- origin/producer vocabulary;
- authorization decision vs execution result;
- content digest/reference for agent prompts/tool payloads;
- explicit redaction evidence;
- additional actor-type acceptance;
- stronger parent/ordering semantics if needed.

## Explicit non-goals

- identity graph;
- agent orchestrator;
- command/task replay;
- generic provenance graph;
- universal DLP;
- full audit product;
- generic authorization engine;
- framework-specific agent core fields.

---

# Candidate next problem areas

This review intentionally does not choose VS6.

## Candidate A — Authority and evidence

Question:

> How can ETLayer distinguish a backend-authoritative business fact from an agent self-report or derived observation?

Potential proof:

```text
agent self-report
+ authoritative tool/backend evidence
→ one governed event assertion
```

This is the strongest new semantic gap found by the review.

## Candidate B — Cross-field semantic governance

Question:

> How does a contract enforce relationships, not just required fields?

Examples:

```text
delegation principal user == user.id
actor/delegation combinations are coherent
authority kind matches claim rules
```

This would harden VS3 for agent-native semantics.

## Candidate C — Privacy-safe agent evidence

Question:

> How can ETLayer retain useful agent/tool evidence without persisting raw sensitive prompts or payloads?

Potential primitives:

```text
digest
reference
policy-controlled preview
redaction evidence
```

This would deepen VS4 without becoming a prompt warehouse.

No candidate should be selected until this review is accepted.

---

# Conclusion

VS1-VS5 are structurally compatible with an agent-native future.

VS5 fixed the most dangerous hidden assumption:

```text
actor == user
```

That assumption is now gone.

The next major semantic risk is different:

```text
assertion == truth
```

In agent systems, an agent saying something happened, a runtime observing a call, and the authoritative backend confirming a state change are different evidence classes.

ETLayer should preserve that distinction if and when it becomes part of a concrete vertical slice.

The architectural direction remains:

```text
OpenTelemetry transport
        ↓
ETLayer semantic event plane
        ├─ contracts
        ├─ privacy
        ├─ identity / actor / delegation
        ├─ causality
        ├─ future authority/evidence
        └─ durable canonical event
              ↓
           projections
              ├─ PostHog
              ├─ Statsig
              ├─ warehouse
              ├─ audit/evidence sinks
              └─ future destinations
```

The product should remain an event layer, not become the systems around it.
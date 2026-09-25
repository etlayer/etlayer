# RFC-0002: Agent control planes as evidence producers and consumers

Status: Research note  
Captured: 2026-09-25  
Source signal: Runlayer

## Why this RFC exists

This document captures a new architecture insight without rewriting ETLayer's current vision, principles, architecture, or roadmap.

It is intentionally additive. It should be consolidated into canonical documentation only during a later review when we compare it with other accumulated RFCs and decide what actually becomes product truth.

## External signal

Runlayer is an adjacent product category rather than a direct ETLayer equivalent.

Its current product surface combines:

- MCP/tool gateway;
- agent identity;
- delegated access;
- policy enforcement;
- credential/grant handling;
- runtime security;
- audit;
- observability.

Official references captured during this research:

- https://www.runlayer.com/platform
- https://www.runlayer.com/identity-policy
- https://www.runlayer.com/mcp-gateway

The useful signal is not "ETLayer should become Runlayer."

The useful signal is that agentic systems create a growing need to preserve identity, authority, policy, action, and outcome context around tool execution.

## Candidate responsibility split

A useful conceptual split to evaluate is:

~~~text
agent control plane
  decides / authorizes / enforces / emits action evidence

trusted evidence plane
  authenticates / preserves / normalizes / routes evidence

operational reasoning plane
  correlates / explains / derives / acts / verifies outcomes
~~~

Under this model, an agent control plane can be both a producer and a consumer of ETLayer evidence without defining ETLayer's product identity.

## Candidate relationship model

Agentic workflows make several relationships easy to accidentally collapse.

Keep evaluating these as separate concepts:

~~~text
trace
  technical execution relationship

correlation
  membership in one longer logical conversation

causation
  B happened because of A

workflow
  membership in one durable orchestration or business process

delegation
  B acted with authority from or on behalf of A

provenance
  why ETLayer believes evidence came from the attributed source
~~~

One event may carry several of these at the same time without them being interchangeable.

## Candidate authority chain

A useful authority chain may look like:

~~~text
principal
  -> immediate actor
  -> client/runtime
  -> connector/adapter
  -> operation
  -> resource
~~~

Potentially useful independent evidence includes:

- represented principal / `on_behalf_of`;
- credential or grant source;
- policy or authorization decision;
- authority scope;
- approval when distinct from authorization;
- action and resource;
- execution result;
- eventual outcome.

Producer-supplied authority and delegation metadata remains a claim until validated or corroborated at an appropriate trust boundary.

## MCP boundary

MCP should be evaluated as one integration/transport surface, not as ETLayer's ontology.

A future MCP adapter could translate MCP activity into ETLayer evidence while leaving actor, authority, provenance, causation, workflow, and outcome semantics protocol-neutral.

## Candidate evidence envelope

A future evidence contract may need independent dimensions for:

- event identity and time;
- immediate actor and subject;
- delegation / represented principal;
- producer, runtime, transport, and trusted provenance;
- correlation, causation, workflow, trace, and session context;
- policy/decision evidence;
- action and resource;
- result/outcome;
- supporting evidence references.

This is a research hypothesis, not a committed schema.

## Product-boundary hypothesis

ETLayer may eventually preserve evidence about:

- agent identity;
- policy decisions;
- tool calls;
- runtime-security findings;
- delegated actions;
- outcomes.

That does not imply that ETLayer itself should become:

- an MCP gateway;
- an agent IAM product;
- a credential broker;
- a runtime-security enforcement system;
- an agent workflow engine.

Those boundaries should be decided from concrete product requirements, not from category adjacency.

## Candidate future work

Possible future spikes, only if a concrete requirement appears:

- MCP evidence adapter;
- authority/delegation chain representation;
- policy-decision evidence;
- causal evidence graph projection;
- agent session/tool-call correlation;
- mapping from an external agent control plane into ETLayer events.

None of these is assigned a vertical-slice number by this RFC.

## Consolidation rule

Do not edit current canonical architecture or roadmap solely because this RFC exists.

During a later weekly/monthly architecture consolidation, compare this RFC with:

- existing ETLayer semantics;
- actual implementation evidence;
- other accumulated RFCs;
- new external market evidence;
- product requirements.

Only then promote the surviving conclusions into canonical docs.

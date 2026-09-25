# RFC-0001: Protocol boundaries and durable causal lineage

Status: Proposed research direction

## Summary

Keep ETLayer's public event data plane centered on OpenTelemetry and OTLP/HTTP.

Evaluate Protobuf + ConnectRPC only for future typed command/query or internal control-plane boundaries where it solves a measured contract or interoperability problem.

Preserve ETLayer correlation and causation independently from OpenTelemetry trace availability so durable business-event lineage remains explainable across retries, workflows, agents, and asynchronous boundaries.

This RFC does not change the current public ingest or product API.

## Current boundaries

ETLayer currently has two deliberately different external surfaces:

~~~text
event data plane
  OTLP/HTTP
  POST /v1/logs

product/control API
  versioned HTTP/JSON
  /api/v1/...
~~~

Those boundaries are already proven and should not be replaced merely because another RPC technology is attractive.

## Protocol layering

The preferred conceptual split is:

~~~text
business/product events
  -> OpenTelemetry event semantics + OTLP/HTTP

public product management
  -> HTTP/JSON + versioned product API

future typed internal/agent command-query surface
  -> current HTTP/JSON unless a measured need appears
  -> Protobuf + ConnectRPC is a leading candidate when schema-first RPC is justified

telemetry about ETLayer itself
  -> OpenTelemetry / OTLP
~~~

An RPC method, an event envelope, and telemetry are different contracts even when they carry the same project or causal identity.

Do not collapse them into one "universal protocol."

## Why ConnectRPC is worth keeping as a candidate

Hatchet provides useful 2026 implementation evidence:

- PR #4987 migrated its engine server from gRPC to ConnectRPC while preserving compatibility with existing gRPC clients. The stated drivers include serverless runtimes, frontend/gRPC-Web compatibility, and future serverless operators.
  https://github.com/hatchet-dev/hatchet/pull/4987
- PR #5016 introduced a configurable TypeScript transport so unary RPCs can use ConnectRPC over HTTP/1.1 or HTTP/2 as available, specifically for edge/serverless compatibility.
  https://github.com/hatchet-dev/hatchet/pull/5016
- Hatchet's server keeps HTTP/1.1 enabled for fetch-based Connect callers while retaining HTTP/2 for gRPC/streaming cases.
  https://github.com/hatchet-dev/hatchet/blob/d116ba72b0383bb74b246d8d15f0189f7f8c16d6/internal/services/grpc/server.go

This evidence is relevant to ETLayer because Cloudflare and browser/edge-adjacent environments make classic gRPC assumptions inconvenient.

It does not justify changing the already-proven OTLP ingest path.

## Explicit non-decision: do not replace OTLP ingest

ETLayer is OTel-native by design.

The following is not proposed:

~~~text
producer
  -> ConnectRPC
  -> ETLayer
~~~

as a replacement for normal event ingest.

That would make the event contract proprietary at exactly the layer where ETLayer currently benefits from standard OpenTelemetry instrumentation and transport.

Connect may become useful for a future typed control surface, but it must remain separate from the canonical event data plane.

## CloudEvents

CloudEvents is not required by this RFC.

It may be evaluated later for a concrete event-bus/webhook interoperability case where a standardized event envelope materially helps.

Do not add CloudEvents merely to create another representation of an event that is already adequately carried through OTLP.

## Durable causal lineage

ETLayer already treats these as distinct first-class dimensions:

~~~text
event identity
correlation
causation
subject
actor
delegation
producer
authority
provenance
project
~~~

That model should remain valid even when no OpenTelemetry trace exists.

Hatchet separately added source workflow-run and step-run metadata to events so cross-workflow trace linking works even without its OTel instrumentor:

https://github.com/hatchet-dev/hatchet/blob/d116ba72b0383bb74b246d8d15f0189f7f8c16d6/sdks/typescript/CHANGELOG.md

The lesson for ETLayer is architectural:

~~~text
durable event/workflow causality
  !=
technical trace continuity
~~~

Therefore:

- correlation and causation must survive storage/replay/revalidation independently from trace sampling.
- trace_id and span_id remain technical execution context, not replacements for ETLayer causation.
- source workflow/run/step identity may be preserved as event context when a producer has that concept.
- ETLayer should not copy Hatchet-specific field names into its semantic kernel.
- if workflow identity becomes common enough to deserve normalized fields, that change requires its own contract decision.
- replay must preserve the original causal context rather than reconstructing it from timestamps.

## Evidence plane versus agent control plane

A useful adjacent-market signal is the emergence of agent control planes that combine gateway routing with identity, delegated access, policy, runtime security, audit, and observability.

Runlayer's current product describes this explicitly:

- platform/control plane: https://www.runlayer.com/platform
- Agent IAM and delegated identity: https://www.runlayer.com/identity-policy
- MCP gateway: https://www.runlayer.com/mcp-gateway

The architectural lesson for ETLayer is separation, not imitation.

An agent-control product answers questions such as:

~~~text
who or what may act?
under whose authority?
through which client/tool?
under which policy?
should the action be allowed?
~~~

ETLayer's durable event/evidence plane answers a different set:

~~~text
what happened?
who or what produced the evidence?
how trustworthy is the source?
what caused what?
which workflow/delegation context applies?
what decision/action/outcome should be preserved and replayable?
~~~

Therefore an agent control plane should be modeled as a producer and/or consumer of ETLayer evidence rather than as ETLayer's product identity.

MCP is likewise one possible transport/adapter. A future MCP integration may map activity into a semantic transport attribute such as `mcp`, but ETLayer's actor, authority, causation, workflow, and outcome semantics must remain protocol-neutral.

## Relationship model

The durable model should keep at least five relationship classes separate:

~~~text
trace       = technical execution relationship
correlation = same longer logical conversation
causation   = B happened because of A
workflow    = same durable business/orchestration process
delegation  = B acted with authority from or on behalf of A
~~~

A sixth dimension, provenance, answers why ETLayer believes a claim came from the producer/source it attributes it to.

These dimensions may all be present on one event and still carry different values and lifecycles.

## Authority chain

Where meaningful, ETLayer should be able to preserve:

~~~text
principal
  -> immediate actor
  -> client/runtime
  -> connector/adapter
  -> action
  -> resource
~~~

with independent evidence for:

- `on_behalf_of` / delegated principal;
- credential source;
- policy or authorization decision;
- authority scope;
- action and resource;
- eventual outcome.

This is a semantic target, not a committed wire schema. Producer claims about this chain remain subject to trusted provenance and authority validation.

## Trust and provenance implications

Producer-supplied workflow/correlation claims are not automatically trusted merely because they use familiar field names.

The existing invariant remains:

~~~text
payload claim != trusted provenance
~~~

A producer may assert causal context only within the authority ETLayer grants that producer.

Any future normalization of workflow/run identity must preserve:

- authenticated producer provenance;
- project isolation;
- authority checks;
- privacy policy;
- append-only decision history where applicable.

## Future ConnectRPC spike gate

Run a ConnectRPC spike only when a real control-plane surface demonstrates at least one of:

- enough methods that hand-written HTTP contracts become error-prone;
- multiple generated-language clients are required;
- schema evolution is becoming costly;
- streaming has a concrete use case;
- typed error/details materially improve operability;
- a long-lived agent/internal service boundary needs a stable IDL.

The spike should compare the current HTTP/JSON approach with Protobuf + Connect over the real Cloudflare path.

Measure:

- TypeScript/Go/Rust ergonomics as applicable;
- HTTP/1.1 and HTTP/2 behavior;
- generated schema evolution;
- error model integration;
- cancellation/deadlines;
- payload limits and compression;
- observability;
- local debugging;
- reverse proxy/CDN behavior;
- compatibility with current product-domain adapters.

## Non-goals

This RFC does not:

- change POST /v1/logs;
- make gRPC a requirement;
- introduce a second event data plane;
- make CloudEvents mandatory;
- replace ETLayer correlation/causation with trace IDs;
- make generated Protobuf messages the ETLayer domain model;
- assign a new vertical-slice number.

## Decision rule

Adopt a new protocol only when it improves a specific ETLayer boundary without weakening the existing standard event ingest or semantic kernel.

The default remains:

~~~text
OTLP for event/telemetry ingest
HTTP/JSON for the proven public product API
explicit causal identity in durable event semantics
new RPC transport only after measured need
~~~

# Design Principles

## 1. OpenTelemetry first

Do not invent a transport, resource model, trace model, or semantic convention when OpenTelemetry already provides one.

ETLayer extensions should be a semantic delta, not a parallel telemetry standard.

## 2. The application owns event meaning

A destination must not define the application's canonical business vocabulary.

Prefer:

`review.completed`

over destination-shaped event names such as:

`posthog_review_conversion`

## 3. Capture once, project many times

One accepted event may produce multiple destination-specific projections.

The producer must not emit separate logical events merely because two analytics systems are connected.

## 4. Preserve before projecting

Destination schemas are projections and may be lossy.

ETLayer must keep enough information to reproduce future projections without asking the original application to emit the event again.

## 5. Replay is a core capability

Replay is not an emergency script.

The storage and exporter model must be designed so a failed, newly added, or replaced destination can consume historical events safely.

## 6. At-least-once means idempotency is mandatory

Queues retry. Networks fail. Workers restart.

Duplicate delivery is normal behavior, not an exceptional edge case.

## 7. Browser events are not automatically authoritative

The browser is appropriate for interaction telemetry.

Authoritative business outcomes should normally be emitted by the system that commits or observes the actual state transition.

## 8. Wide, but intentional

Capture information that is semantically useful and difficult to reconstruct later.

Do not use "lossless" as an excuse to collect arbitrary headers, cookies, DOM state, secrets, or unnecessary personal data.

## 9. Privacy before routing

Sensitive fields should be classified and filtered before downstream export.

A destination must never become the accidental privacy boundary.

## 10. Cloudflare is a reference runtime

The first vertical slice uses Cloudflare because it gives ETLayer an inexpensive production-like environment.

Core semantics must remain portable to another runtime.

## 11. Prefer boring primitives

HTTP, OTLP, immutable storage, queues, explicit schemas, deterministic transforms.

Avoid building a custom distributed system until a proven requirement demands it.

## 12. Delete ETLayer conventions when standards catch up

If OpenTelemetry standardizes something ETLayer previously defined, migrate toward the upstream standard and deprecate the custom convention.


## 13. Protocols are adapters, not ontology

OTLP, HTTP/JSON, CloudEvents, MCP, queues, and future RPC transports describe how information crosses a boundary.

They must not define the canonical meaning of actor, delegation, causation, workflow, authority, action, or outcome.

## 14. Keep authority and delegation explicit

The immediate actor, represented principal, credential source, policy decision, and authority scope are different facts.

Do not overwrite the actor with the user or service on whose behalf it acts, and do not trust producer-supplied delegation merely because the field name is familiar.

## 15. Record control decisions without becoming the control plane

ETLayer may ingest, preserve, route, and replay evidence about identity, policy, security, tool calls, and outcomes.

It is not therefore required to become an MCP gateway, agent IAM product, or runtime-security enforcement plane. Those systems should integrate as producers and consumers.

## 16. Accepted data is append-only, including duplicates

Every accepted new fact, event, evidence item, decision, action, delivery attempt, or receipt is appended as a new immutable record.

Do not overwrite or physically deduplicate historical source data merely because the logical payload, source event ID, idempotency key, or content hash matches an earlier record.

Keep these concepts separate:

~~~text
logical identity
  says which business/event fact a producer intended

record / receipt identity
  says which concrete occurrence ETLayer accepted and persisted

deduplication
  is a read/projection/side-effect concern
  and never a reason to erase an accepted occurrence
~~~

A retried delivery may therefore preserve the same logical event identity while receiving a new append-only receipt/record identity.

Idempotency protects downstream effects. It must not destroy evidence that a duplicate delivery actually occurred.

Corrections, supersession, revocation, reclassification, and deletion intent are represented by later records that reference earlier records. They do not rewrite history.

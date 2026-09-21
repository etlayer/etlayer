# Vision

## What ETLayer is

ETLayer is an open-source, vendor-neutral event data plane for product and business telemetry.

Applications emit product and business events using OpenTelemetry concepts and OTLP transport. ETLayer receives those events, applies business-event semantics and policy, preserves a lossless source of truth, and projects the events into systems such as product analytics, experimentation platforms, warehouses, and other downstream consumers.

The core promise is:

> Emit once. Own the event. Route and replay it anywhere.

## The problem

Product analytics commonly starts with a vendor SDK embedded directly into application code:

```text
application -> vendor SDK -> vendor backend
```

That is convenient at first, but it couples application instrumentation to:

- a vendor event model;
- a vendor identity model;
- a vendor transport;
- a vendor retention policy;
- a vendor's current feature set.

It also makes historical replay, migration, governance, and multi-destination routing difficult.

ETLayer changes the dependency direction:

```text
application
    |
OpenTelemetry / OTLP
    |
ETLayer
    |
    +-- product analytics
    +-- experimentation
    +-- warehouse
    +-- archive
    +-- future consumers
```

The application owns the meaning of the event. ETLayer owns delivery, preservation, governance, and projection. Destinations are consumers.

## Relationship to OpenTelemetry

ETLayer is not an alternative to OpenTelemetry.

OpenTelemetry should own as much as possible of:

- instrumentation APIs;
- event/log representation;
- resource attributes;
- trace context;
- transport through OTLP;
- standard semantic conventions.

ETLayer should own only the layer that remains product-specific:

- product and business event contracts;
- schema governance;
- identity and attribution semantics;
- authority rules;
- privacy policy;
- durable preservation;
- routing and vendor projection;
- deterministic replay.

When OpenTelemetry standardizes a concept that ETLayer previously defined, ETLayer should prefer the OpenTelemetry convention and deprecate its own.

## What success looks like

A producer should not need to know whether a downstream system is PostHog, Amplitude, Statsig, a warehouse, or something that does not exist yet.

A backend should be able to emit an authoritative business event once.

A browser should be able to emit interaction events without becoming the authority for server-confirmed outcomes.

A destination outage should not require the application to recreate historical events.

Replacing a destination should be a routing and projection change, not an application-wide instrumentation rewrite.

## Non-goals

ETLayer is not initially:

- a product analytics UI;
- an experimentation statistics engine;
- a session replay product;
- a replacement for the OpenTelemetry Collector;
- a general-purpose message broker;
- a full customer data platform;
- an identity graph platform.

Some of those capabilities may integrate with ETLayer. They are not the core product.

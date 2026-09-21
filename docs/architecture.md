# Architecture

## System boundary

ETLayer sits between event producers and event consumers.

```text
Browser      Backend      Worker      Job      CLI
   \           |           |          |        /
    \          |           |          |       /
             OpenTelemetry
                   |
                OTLP/HTTP
                   |
             ETLayer Gateway
                   |
       validate / normalize / enrich
                   |
                 Queue
                   |
            durable persistence
                   |
          route / project / export
             /       |        \
        PostHog   warehouse   future
```

The first reference runtime is Cloudflare. The architecture must not make Cloudflare a requirement of the core event model.

## Components

### Producers

A producer is any process that creates an event.

Examples:

- browser;
- application backend;
- Cloudflare Worker;
- background job;
- webhook handler;
- executor;
- CLI.

Different producers may use different SDKs or helper libraries. They must converge on the same protocol and semantics.

### Ingest gateway

The gateway accepts OTLP/HTTP traffic.

Responsibilities:

- authenticate ingestion;
- enforce request limits;
- decode OTLP;
- reject malformed payloads;
- attach trusted ingest metadata;
- enqueue accepted records.

The gateway should avoid destination-specific behavior.

### Processing

Processing turns accepted telemetry into an ETLayer-managed event lifecycle.

Responsibilities may include:

- semantic validation;
- normalization;
- schema-version checks;
- privacy filtering;
- trusted enrichment;
- idempotency;
- routing decisions.

Processing must preserve the original event representation needed for later replay.

### Durable event store

The durable store is the recovery boundary.

A downstream exporter may fail without causing the source event to be lost.

The first Cloudflare slice uses object storage as a simple immutable event archive. A future runtime may use another durable store without changing the producer contract.

### Exporters

An exporter converts an ETLayer event into a destination-specific projection.

Examples:

- PostHog;
- warehouse;
- Statsig/Amplitude;
- OTLP destination;
- stdout/JSONL.

A projection is allowed to be lossy. The durable ETLayer representation is not.

### Replay

Replay reads previously accepted events and re-runs destination projection and delivery.

Replay must be:

- deterministic for a specified exporter version and configuration;
- safe under retries;
- observable;
- scoped by time and, later, tenant/event/schema filters.

## Authority model

Not all producers are equally authoritative.

Examples:

| Event | Typical authority |
| --- | --- |
| `landing.hero.exposed` | browser or edge |
| `landing.hero.cta_clicked` | browser |
| `signup.started` | browser or backend |
| `user.created` | backend |
| `github_app.installed` | GitHub webhook/backend |
| `payment.completed` | payment webhook/backend |
| `review.completed` | backend/executor |

ETLayer should preserve the source and authority context rather than treating every event as equally trustworthy.

## Delivery semantics

VS1 assumes at-least-once delivery between internal stages.

Therefore:

- every managed event needs a stable event identity;
- consumers must tolerate duplicates;
- exporters must implement idempotency where the destination allows it;
- ETLayer must distinguish retry from a new logical event.

Global ordering is not assumed.

Ordering-sensitive analysis should use event timestamps, causal identifiers, and domain sequence information where available.

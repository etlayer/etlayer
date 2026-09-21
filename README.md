# ETLayer

**ETLayer is an OTel-native event data plane for product and business events.**

ETLayer receives OpenTelemetry events, applies business-event semantics and policy, preserves a lossless source of truth, and projects events into analytics and experimentation systems without coupling application code to a vendor.

> Emit once. Own the event. Route and replay it anywhere.

## Why ETLayer?

Product events often start life inside a vendor SDK. That makes the analytics backend part of the application contract and makes migrations, replay, governance, and multi-destination routing harder than they should be.

ETLayer keeps those concerns separate:

```text
Applications
    |
OpenTelemetry / OTLP
    |
 ETLayer
    |
    +-- validate / normalize
    +-- enrich / redact
    +-- persist
    +-- route / project
    +-- replay
    |
    +-- PostHog
    +-- warehouse
    +-- future destinations
```

ETLayer is not an analytics UI and is not intended to replace OpenTelemetry. OpenTelemetry owns instrumentation and transport. ETLayer focuses on the product and business event data plane after ingestion.

## First vertical slice

The first reference implementation targets Cloudflare:

```text
OTLP/HTTP
   |
Cloudflare Worker
   |
Cloudflare Queue
   |
   +-- lossless canonical storage
   +-- PostHog exporter
   +-- replay
```

The slice is intentionally small. Its job is to prove that browser and backend events can travel through the same OTel-native pipeline, remain recoverable, and reach PostHog without either producer knowing PostHog exists.

See [VS1: Cloudflare Event Gateway](docs/vertical-slices/vs1-cloudflare.md).

## Design principles

- OTel-native, not OTel-adjacent
- Vendor-neutral application instrumentation
- Lossless before lossy projections
- Explicit, versioned business-event contracts
- Server-side authority for authoritative business outcomes
- Replay and idempotency as first-class capabilities
- Cloudflare is the first runtime, not a core dependency

## Status

Early design and first vertical slice.

The public API and semantic conventions are expected to change while VS1 is being proven.

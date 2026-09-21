# Protocol

## Decision

ETLayer does not define a proprietary wire protocol for product and business events.

The primary ingestion protocol is OTLP/HTTP.

This keeps ETLayer compatible with the OpenTelemetry ecosystem and allows standard instrumentation to target ETLayer without embedding a destination SDK.

## Endpoint

The primary endpoint follows OTLP logs conventions:

```http
POST /v1/logs
```

VS1 prioritizes OTLP JSON for implementation simplicity. Protobuf support should be added without changing the event contract.

## Event representation

ETLayer product/business events are represented using the OpenTelemetry event model carried through the logs signal.

An accepted event should have:

- an event name;
- an occurrence timestamp;
- resource context;
- attributes;
- optional trace/span correlation;
- ETLayer extension attributes only where no suitable upstream semantic convention exists.

## No proprietary outer envelope

ETLayer must not require producers to wrap OTLP in a second ETLayer-specific event envelope.

Trusted ingestion metadata may be attached by the gateway after receipt.

## Authentication

The first hosted/reference deployment may use bearer-style ingestion credentials:

```http
Authorization: Bearer <ingest-key>
```

Authentication is deployment metadata, not part of event semantics.

## Batching

OTLP batching is supported by the transport.

The gateway may enqueue individual managed events or batches internally. That internal choice must not change producer semantics.

## Error classes

The gateway should distinguish:

- authentication failure;
- unsupported content type;
- malformed OTLP;
- semantic validation failure;
- rate/size limit;
- temporary internal failure.

Retryable and non-retryable failures should be explicit.

## Compatibility rule

A standard OpenTelemetry producer should be able to target ETLayer with configuration plus, where needed, ETLayer semantic conventions.

ETLayer-specific SDKs are convenience layers only. They must not become a second mandatory protocol.

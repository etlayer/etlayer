# Cloudflare ingest

The first executable ETLayer gateway.

It accepts named OpenTelemetry events over OTLP/HTTP JSON and enqueues a loss-preserving managed representation for downstream persistence and export.

## Endpoint

```text
POST /v1/logs
Content-Type: application/json
Authorization: Bearer <ingest-key>
```

Successful OTLP/HTTP requests return `200 OK` with an empty JSON `ExportLogsServiceResponse`:

```json
{}
```

VS1 accepts JSON only. Protobuf support can be added without changing the product event contract.

## Accepted records

ETLayer is intentionally stricter than a generic OTLP logs receiver in VS1: each accepted `LogRecord` must have a non-empty `eventName` because this gateway is for product and business events rather than arbitrary application logs.

The gateway preserves the original:

- resource;
- instrumentation scope;
- log record;
- occurrence/observation timestamps;
- trace/span fields present in the log record.

It also attaches trusted receive time and a stable ETLayer event identity. A producer-supplied `etlayer.event.id` is preserved; otherwise the gateway creates one.

## Local setup

Create the queue once:

```bash
npx wrangler queues create etlayer-events
```

Set the ingest key:

```bash
npx wrangler secret put ETLAYER_INGEST_KEY
```

Then run:

```bash
npx wrangler dev
```

The next VS1 step consumes the queue and writes the replayable durable event archive.

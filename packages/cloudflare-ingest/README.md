# Cloudflare ingest

The first executable ETLayer gateway.

It accepts named OpenTelemetry events over OTLP/HTTP JSON, places them on Cloudflare Queues, and consumes those messages into an immutable R2 event archive.

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

## Durable archive

The same Worker consumes `etlayer-events` and writes each managed event to R2.

The object key is deterministic:

```text
events/YYYY/MM/DD/HH/<url-encoded-event-id>.json
```

Writes use a create-only conditional operation.

- the first delivery stores the event;
- an identical retry is acknowledged as a duplicate without rewriting the object;
- the same archive identity with different content is treated as a conflict and retried;
- repeatedly failing messages move to `etlayer-events-dlq`.

Each object stores SHA-256 and event metadata alongside the JSON body. The archived body is the replay source for later exporters.

## Local / first deployment setup

Create the queue and archive bucket once:

```bash
npx wrangler queues create etlayer-events
npx wrangler queues create etlayer-events-dlq
npx wrangler r2 bucket create etlayer-events-archive
```

Set the ingest key:

```bash
npx wrangler secret put ETLAYER_INGEST_KEY
```

Then run:

```bash
npx wrangler dev
```

The next VS1 step is the PostHog exporter reading the same managed event representation.

# Cloudflare ingest

The first executable ETLayer gateway.

It accepts named OpenTelemetry events over OTLP/HTTP JSON, places them on Cloudflare Queues, persists them into an immutable R2 event archive, and optionally projects them into PostHog.

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

VS1 accepts JSON only.

## Durable archive

The Worker consumes `etlayer-events` and writes each managed event to R2 before any destination export is considered successful.

The object key is deterministic:

```text
events/YYYY/MM/DD/HH/<url-encoded-event-id>.json
```

Writes are create-only and include SHA-256 metadata. Identical retries are acknowledged as duplicates; an event-id/content conflict is retried rather than overwriting history.

## PostHog exporter

When `POSTHOG_PROJECT_TOKEN` is configured, the queue consumer projects the durable ETLayer event into PostHog using the public Capture API.

The application producer remains vendor-neutral.

Mapping highlights:

- `event.eventName` -> PostHog `event`;
- ETLayer/OTel attributes -> PostHog event properties;
- `user.id`, then anonymous/session/account identity -> `distinct_id`;
- no usable identity -> a synthetic ETLayer distinct ID with `$process_person_profile=false`;
- original occurrence time -> PostHog `timestamp`;
- ETLayer event identity -> stable PostHog `uuid`.

A PostHog failure causes the queue message to retry. The R2 write is duplicate-safe, so a retry does not rewrite the canonical event. PostHog recommends supplying a stable event UUID because retries with the same UUID and event identity can be deduplicated.

Set the destination secret:

```bash
npx wrangler secret put POSTHOG_PROJECT_TOKEN
```

Optionally set the ingest region/host:

```text
POSTHOG_HOST=https://us.i.posthog.com
```

Use the correct project region. The default is US Cloud.

## Local / first deployment setup

Create the queue, dead-letter queue, and archive bucket once:

```bash
npx wrangler queues create etlayer-events
npx wrangler queues create etlayer-events-dlq
npx wrangler r2 bucket create etlayer-events-archive
```

Set the ETLayer ingest key:

```bash
npx wrangler secret put ETLAYER_INGEST_KEY
```

Then run:

```bash
npx wrangler dev
```

## Agent-verifiable acceptance

The exporter is considered complete only when an agent can query the destination and find the event by the original `etlayer.event.id`.

The intended loop is:

```text
fixture -> ETLayer -> Queue -> R2 -> PostHog -> MCP query -> assert
```

## Deterministic replay

VS1 can replay a missing destination interval from the immutable R2 archive without recreating the business event.

The operator endpoint is:

```text
POST /_ops/replay/posthog
Authorization: Bearer <replay-key>
Content-Type: application/json
```

Replay uses a half-open time range `[from, to)`, reads canonical events from R2 in deterministic order, and passes them through the same PostHog projector. Original event identity and occurrence time are preserved, so the PostHog UUID remains stable across retries.

Replay delivery metadata is destination-only:

```text
etlayer.delivery.mode = replay
etlayer.replay.id      = <replay id>
```

The canonical R2 object is never rewritten.

For VS1 use the one-time operator helper:

```bash
./scripts/once/replay-posthog.sh \
  --from 2026-09-21T18:36:00Z \
  --to   2026-09-21T18:45:00Z
```

The helper rotates an independent `ETLAYER_REPLAY_KEY`, deploys the current Worker, and invokes the replay endpoint.

See `docs/acceptance/replay.md` for the recovery proof.

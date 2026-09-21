# VS1: Cloudflare Event Gateway

**Status: Complete — live acceptance passed on 2026-09-21.**

## Goal

Prove the smallest useful ETLayer pipeline in production-like conditions.

VS1 succeeds when one browser event and one backend event can travel through the same OTel-native ingestion path, be durably preserved, reach PostHog through a destination adapter, and later be replayed without either producer knowing PostHog exists.

## Reference flow

```text
Browser / Backend
       |
   OTLP/HTTP
       |
Cloudflare Worker
       |
Cloudflare Queue
       |
Consumer Worker
       |
       +-- durable event archive
       |
       +-- PostHog exporter
```

## Initial use case

Use a real ETLayer consumer product rather than a synthetic demo.

A minimal funnel:

```text
landing.hero.exposed       browser/edge
        |
landing.hero.cta_clicked   browser
        |
account.created            backend
```

An A/B experiment may attach experiment context to the first two events, but ETLayer does not need to implement experiment assignment or statistical analysis in VS1.

## Producer API

The protocol is OTLP/HTTP.

A future helper API may expose:

```ts
etel.capture("landing.hero.cta_clicked", {
  "experiment.id": "hero.v1",
  "experiment.variant": "b"
})
```

The helper must compile down to the supported OpenTelemetry event/log representation and OTLP transport. It must not create a second proprietary event protocol.

## Ingest

VS1 accepts OTLP over HTTP.

Minimum requirements:

- OTLP JSON first;
- protobuf may follow immediately if cheap to support;
- bearer-style ingest authentication;
- request-size limit;
- malformed-payload rejection;
- no destination-specific fields required from producers.

## Queue

Accepted events are put onto Cloudflare Queues.

Assumptions:

- at-least-once processing;
- no global ordering guarantee;
- retry is expected;
- duplicate-safe downstream processing is required.

## Persistence

Before a destination export is considered complete, ETLayer must preserve a replayable representation in durable storage.

VS1 may use R2 with an append-like immutable object layout.

Example logical key:

```text
events/YYYY/MM/DD/HH/<event-id>.json
```

The exact physical layout is an implementation detail and may change after measurements.

## PostHog exporter

The first exporter projects ETLayer events into PostHog.

Requirements:

- application code contains no PostHog SDK calls;
- exporter mapping is isolated from core event semantics;
- unsupported fields may be omitted from the PostHog projection;
- omission from PostHog must not remove those fields from the durable ETLayer record;
- retry must not create uncontrolled duplicate logical events.

## Replay

VS1 must provide a minimal replay mechanism.

Conceptually:

```bash
etel replay \
  --from 2026-09-21T10:00:00Z \
  --to 2026-09-21T11:00:00Z \
  --exporter posthog
```

The first implementation may be an admin command or script rather than a polished CLI.

## Definition of Done

1. Open the reference landing page.
2. Emit `landing.hero.exposed`.
3. Click the primary CTA.
4. Emit `landing.hero.cta_clicked`.
5. Complete one backend state transition.
6. Emit `account.created` from the backend.
7. All events arrive through the ETLayer OTLP ingest path.
8. Every event has a durable replayable copy.
9. PostHog receives the expected projection.
10. The browser and backend contain no PostHog-specific instrumentation.
11. Disable or intentionally fail the PostHog exporter.
12. Generate additional events.
13. Restore the exporter.
14. Replay the stored interval.
15. PostHog receives the replayed events.
16. Retries do not create uncontrolled duplicate logical events.

## Live acceptance evidence

VS1 was verified against the deployed Cloudflare reference runtime and the intended EU PostHog project.

### Clean browser + backend funnel

Correlation:

```text
vs1-20260921T201828Z-85a2563a
```

Exactly three destination events were observed:

```text
landing.hero.exposed
  af7840e7-ae79-4e32-b623-6a18982f583c
        |
        v causation.id
landing.hero.cta_clicked
  d073fe88-1f5a-4237-818b-8c104bc513a9
        |
        v causation.id
account.created
  8a3ba64f-3c47-4dc8-86f1-c68dc0eca136
```

Verified properties:

- one shared anonymous actor / destination `distinct_id`;
- browser events carried `experiment.id=hero.v1` and `experiment.variant=fixture-a`;
- the backend event carried `account.id=fixture_2911fa48-4544-4494-8593-608b7d3e564a`;
- producer authority was `interaction` for browser events and `business_state` for the backend event;
- no duplicate logical events were present for the correlation id.

### Destination outage + recovery

PostHog projection was intentionally disabled while the fixture completed another full funnel.

Correlation:

```text
outage-20260921T203403Z-7f263cf4
```

Outage window:

```text
[2026-09-21T20:34:03Z, 2026-09-21T20:35:05Z)
```

Before replay, PostHog contained zero rows for this correlation id.

Replay:

```text
replay-20260921T203706Z-a9f3552f
```

The replay selected exactly three canonical R2 events and exported exactly three destination events:

```text
28bf92aa-a0d1-4d08-bb65-5da25d559c3c  landing.hero.exposed
140bed91-120d-4184-b49b-026e0a72381e  landing.hero.cta_clicked
dc781d79-4540-4038-93d0-40027b2004ee  account.created
```

PostHog verification showed exactly one row per original UUID. All three rows retained the original occurrence time, correlation and causation data, and carried:

```text
etlayer.delivery.mode = replay
etlayer.replay.id = replay-20260921T203706Z-a9f3552f
```

This demonstrates preserve-first/project-second recovery with destination-side deduplication.

## Explicit non-goals

VS1 does not include:

- Statsig or Amplitude exporters;
- Snowflake or ClickHouse;
- a full identity graph;
- session replay;
- an experimentation statistics engine;
- a schema-registry UI;
- billing;
- a multi-tenant dashboard;
- SDKs for multiple server languages;
- multi-region guarantees.

## What VS1 proves

If VS1 works, ETLayer has demonstrated its central product claim:

> An application can emit a product or business event once, retain ownership of that event, and safely project or replay it into a downstream analytics system.

# VS2: Multi-destination routing

**Status: Complete — live multi-destination acceptance passed on 2026-09-21.**

## Goal

Prove that one canonical ETLayer event stream can feed multiple independent downstream systems without producer changes.

Reference destinations:

- PostHog;
- Statsig.

```text
Application
    |
    | OTel event / OTLP
    v
  ETLayer
    |
    +--> canonical R2 record
    |
    +--> PostHog
    |
    +--> Statsig
```

## Product claim

> Emit once. Own the canonical event. Project it into multiple destinations independently.

VS1 proved preserve-first delivery and replay to one downstream system. VS2 proves that destination choice is an ETLayer concern rather than a producer concern.

## Architectural boundary

Canonical persistence and destination projection are separate lifecycle stages.

```text
OTLP ingest
    |
    v
Queue
    |
    v
Canonical R2 archive
    |
    v
Destination router
    |
    +--> PostHog adapter
    |
    +--> Statsig adapter
```

The router owns destination selection and delivery outcomes. Individual adapters own only vendor projection and transport.

### Important migration rule

The first VS2 change extracts the router boundary while preserving VS1 behavior. Do **not** weaken current delivery retry semantics just to introduce the abstraction.

Independent failure handling is introduced only when ETLayer has a deterministic way to retain failed-destination recovery coordinates.

## Statsig transport

ETLayer will call Statsig's server-side HTTP custom-event endpoint:

```text
POST https://api.statsig.com/v1/log_event
statsig-api-key: <server secret>
```

The application does not install or call a Statsig SDK.

The Worker secret is expected to be named:

```text
STATSIG_SERVER_SECRET
```

## Initial Statsig projection

For ordinary product/business events:

```text
ETLayer eventName           -> Statsig eventName
original occurrence time    -> Statsig time
ETLayer primary identity    -> Statsig user.userID
account/session identifiers -> Statsig user.customIDs when appropriate
ETLayer event id            -> metadata["etlayer.event.id"]
correlation.id              -> metadata["correlation.id"]
causation.id                -> metadata["causation.id"]
other eligible attributes   -> metadata
```

The adapter must obey destination field and payload limits rather than silently producing invalid requests.

## Exposure semantics

A product event named `landing.hero.exposed` is **not automatically a Statsig experiment exposure**.

Statsig custom-event logging and Statsig exposure logging are different semantic operations.

VS2 initially projects ETLayer events to Statsig custom events. Explicit Statsig exposure projection requires a separate contract and is outside the first implementation slice.

## Identity

Reference priority for Statsig `userID`:

1. `user.id`;
2. `actor.anonymous.id`;
3. `session.id`;
4. `account.id`;
5. deterministic ETLayer fallback.

Where useful, additional stable identifiers may be preserved as Statsig `customIDs`.

The mapping must remain deterministic across live delivery and replay.

## Failure model

Desired VS2 behavior:

```text
canonical R2 write  ✓

PostHog  ✓
Statsig  ✗
```

must not become:

```text
PostHog  ✗ only because Statsig failed
```

A failed destination must be recoverable from the canonical event without producer involvement.

The minimal VS2 implementation may use explicit targeted replay by time range rather than a generalized workflow engine.

## Targeted replay

Replay must name the destination.

Conceptually:

```bash
etel replay \
  --from 2026-09-22T10:00:00Z \
  --to   2026-09-22T10:05:00Z \
  --to statsig
```

Replaying Statsig must not invoke PostHog.

## Acceptance

1. Emit `landing.hero.exposed` once from the existing fixture.
2. Store one canonical ETLayer event in R2.
3. Observe the same logical event in PostHog.
4. Observe the same logical event in Statsig.
5. Repeat for `landing.hero.cta_clicked`.
6. Repeat for eligible `account.created`.
7. Confirm producer code contains no PostHog- or Statsig-specific instrumentation.
8. Confirm `etlayer.event.id` traces the logical event across both destinations.
9. Disable or intentionally fail Statsig only.
10. Generate a new complete fixture funnel.
11. Confirm canonical R2 persistence continues.
12. Confirm PostHog continues receiving the funnel.
13. Confirm Statsig does not receive the outage interval.
14. Restore Statsig.
15. Replay only the missing interval to Statsig.
16. Confirm PostHog did not receive replay duplicates.
17. Confirm Statsig contains exactly the intended logical events without uncontrolled duplicates.

## Implementation slices

### VS2.1 — Router boundary — complete

- destination-router abstraction introduced;
- PostHog routed through the new boundary;
- VS1 behavior retained while the boundary was extracted.

### VS2.2 — Statsig adapter — complete

- canonical ETLayer events project to Statsig custom events;
- identity, timestamp, metadata, errors, disabled mode, and no-exposure reinterpretation are unit-tested;
- runtime activation is controlled only by `STATSIG_SERVER_SECRET`.

### VS2.3 — Independent outcomes — complete

- all configured destinations are attempted independently;
- one adapter failure does not prevent another healthy adapter from running;
- per-destination delivery state is persisted under `deliveries/<destination>/<event-id>.json`;
- canonical R2 persistence remains the authority;
- queue retry remains available if delivery-state persistence itself cannot be recorded.

### VS2.4 — Targeted replay — complete

- replay is destination-aware;
- `/_ops/replay/posthog` remains compatible;
- `/_ops/replay/statsig` replays only Statsig;
- tests prove Statsig-targeted replay does not invoke PostHog;
- acceptance helpers are destination-aware while the old PostHog wrappers remain compatible.

### VS2.5 — Live acceptance — complete

- Statsig Server Secret configured as `STATSIG_SERVER_SECRET`;
- deployed VS2 branch to the Cloudflare reference runtime;
- verified the clean funnel in PostHog and successful Statsig delivery state for the same three logical events;
- ran a Statsig-only outage while PostHog remained healthy;
- restored Statsig and replayed only the missing interval;
- repeated the same Statsig replay and observed zero additional exports;
- independently verified PostHog remained at exactly one row per original UUID.

## Live acceptance evidence

### Baseline multi-destination funnel

Correlation:

```text
vs1-20260921T213806Z-cb0ccede
```

Logical events:

```text
landing.hero.exposed
  93d83f38-cc22-40c4-a8b6-46dd0bdbc18c
        |
        v causation.id
landing.hero.cta_clicked
  8109a18c-b3a6-4d16-a125-d1fc821f18a3
        |
        v causation.id
account.created
  8cd7550b-0631-4349-b80d-b189d6cbbe55
```

PostHog contained exactly those three logical events with one actor and the expected causal chain.

ETLayer durable delivery state recorded:

```text
statsig / 93d83f38-cc22-40c4-a8b6-46dd0bdbc18c -> exported
statsig / 8109a18c-b3a6-4d16-a125-d1fc821f18a3 -> exported
statsig / 8cd7550b-0631-4349-b80d-b189d6cbbe55 -> exported
```

This proves one producer stream reached both configured destinations without producer-specific PostHog or Statsig instrumentation.

### Statsig-only outage

Correlation:

```text
vs2-statsig-outage-20260921T214628Z-676abe8c
```

Window:

```text
[2026-09-21T21:46:25Z, 2026-09-21T21:47:14Z)
```

While Statsig projection was deliberately disabled:

```text
PostHog  -> 3/3 exported
Statsig  -> 3/3 skipped, reason=statsig_disabled
R2       -> canonical events preserved
```

The logical events were:

```text
3f6bd6c7-50b3-4c99-a75d-2cbae6f24eb0  landing.hero.exposed
55ec3642-bd00-4873-967a-96f1191d81ae  landing.hero.cta_clicked
79083104-bec1-4238-9f91-dc3b08fc27ca  account.created
```

PostHog retained the correct actor and causation chain throughout the Statsig-only outage.

### Statsig-only recovery and idempotency

After Statsig was restored, targeted replay of the outage interval produced:

```text
selected: 3
exported: 3
skipped: 0
```

Replay ID:

```text
replay-statsig-20260921T215240Z-f8d98d8c
```

Running the same Statsig-only replay again produced:

```text
selected: 3
exported: 0
skipped: 3
reason: already_exported
```

Second replay ID:

```text
replay-statsig-20260921T215305Z-4b79789c
```

An independent PostHog query after both Statsig replays still showed exactly one row for each original UUID.

This proves:

- one canonical event can feed multiple destinations;
- one destination can fail without blocking another healthy destination;
- recovery can target only the missing destination;
- replay does not fan out to unrelated destinations;
- ETLayer-side durable delivery state prevents repeated replay from producing uncontrolled duplicate outbound deliveries.

## Non-goals

VS2 does not include:

- Amplitude or additional exporters;
- schema registry UI;
- identity graph;
- experiment assignment;
- statistical analysis;
- generic workflow orchestration;
- automatic backfill scheduling;
- billing;
- multi-tenant dashboard;
- new producer SDKs.

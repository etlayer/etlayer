# VS2: Multi-destination routing

**Status: In progress.**

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

### VS2.1 — Router boundary

- introduce a destination-router abstraction;
- keep PostHog as the only configured destination;
- preserve VS1 behavior and tests.

### VS2.2 — Statsig adapter

- project canonical ETLayer events to Statsig custom events;
- add unit tests for identity, timestamp, metadata, limits, and errors;
- configuration through Worker secrets only.

### VS2.3 — Independent outcomes

- run all configured destinations without one adapter preventing another healthy adapter from being attempted;
- retain enough failure evidence to make recovery deterministic;
- preserve canonical persistence as the authority.

### VS2.4 — Targeted replay

- make replay destination-aware;
- support Statsig-only replay;
- prove that targeted replay does not invoke PostHog.

### VS2.5 — Live acceptance

- deploy;
- verify PostHog + Statsig;
- run Statsig-only outage;
- replay;
- verify destination isolation and dedupe.

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

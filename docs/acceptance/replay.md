# VS1 PostHog replay acceptance

Issue #5 proves that destination delivery is recoverable from ETLayer's canonical R2 archive.

## Contract

Replay selects canonical events by ETLayer `receivedAt` using a half-open interval:

```text
[from, to)
```

The replay path:

```text
R2 canonical archive
        |
        v
deterministic time-range selection
        |
        v
same PostHog projector
        |
        v
same event name / identity / occurrence time / UUID
```

Replay does **not** create a new business event. Destination delivery metadata is added only to the PostHog projection:

```text
etlayer.delivery.mode = replay
etlayer.replay.id      = <operator replay id>
```

The canonical R2 object is not modified.

Retries remain bounded by the stable PostHog UUID derived from the original `etlayer.event.id`.

## Region safety

Replay uses the same destination configuration as live delivery. The PostHog region must be explicit and must match the project token.

For the current ETLayer reference project:

```text
POSTHOG_HOST=https://eu.i.posthog.com
```

A configured token without a configured host is treated as a configuration error.

## Operator command

The VS1 helper uses an independently rotated replay credential, not the producer ingest key:

```bash
./scripts/once/replay-posthog.sh \
  --from 2026-09-21T18:36:00Z \
  --to   2026-09-21T18:45:00Z
```

The helper:

1. rotates `ETLAYER_REPLAY_KEY`;
2. deploys the current Worker;
3. calls `POST /_ops/replay/posthog`;
4. prints the selected/exported events and their stable UUIDs.

## Recovery proof

The strongest VS1 proof is:

1. PostHog destination is unavailable or misconfigured.
2. Producers continue sending events.
3. Events remain in R2.
4. Destination configuration is corrected.
5. Replay the missing interval.
6. Verify the original event IDs appear in the intended PostHog project.
7. Retry the replay and confirm no uncontrolled logical duplicates.

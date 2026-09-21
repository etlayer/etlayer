# VS1 browser + backend funnel acceptance

Issue #6 is the final end-to-end VS1 proof.

## Funnel

```text
landing.hero.exposed
        |
        v
landing.hero.cta_clicked
        |
        v
account.created
```

The first two events are interaction-authoritative browser events. `account.created` is emitted only after the fixture backend persists an account object into its own R2 state bucket.

All three events carry:

```text
actor.anonymous.id
correlation.id
etlayer.producer.kind
etlayer.authority.kind
```

The CTA carries `causation.id=<hero exposure event id>`.

The backend event carries `causation.id=<CTA event id>`.

The two browser events also carry:

```text
experiment.id = hero.v1
experiment.variant = fixture-a
```

## Deploy

```bash
./scripts/once/deploy-fixture.sh
```

The helper rotates one shared ingest credential into both Workers, deploys the current ETLayer Worker and the producer fixture, verifies both health endpoints, and prints a one-time acceptance URL with a known `correlation.id`.

Open exactly that URL and complete the two enabled actions in order.

## Machine verification

After the page reports `funnel complete`, query PostHog by the printed `correlation.id`.

Expected:

- exactly one `landing.hero.exposed`;
- exactly one `landing.hero.cta_clicked`;
- exactly one `account.created`;
- one shared `distinct_id` derived from `actor.anonymous.id`;
- causal chain exposure -> CTA -> account;
- backend event has an `account.id`;
- only browser events carry experiment context.

## Outage + replay

Disable projection while preserving canonical archive:

```bash
./scripts/once/posthog-export-mode.sh disable
```

Run another fixture funnel and record its `correlation.id`.

Restore projection:

```bash
./scripts/once/posthog-export-mode.sh enable
```

Replay the missing interval:

```bash
./scripts/once/replay-posthog.sh --from <from> --to <to>
```

Then query PostHog for the outage funnel and verify exactly one row per original event UUID.

This proves that producer behavior is independent of the analytics destination.

# Once / acceptance helpers

These scripts exist to reproduce and diagnose the first ETLayer Cloudflare vertical slice.

They are intentionally **not** the long-term ETLayer CLI. Keep them while VS1 remains useful as a reproducible acceptance environment; replace them with durable provisioning or CLI commands when those interfaces stabilize.

All deployment commands use local Wrangler OAuth. No `CLOUDFLARE_API_TOKEN` is required.

## bootstrap-cloudflare.sh

Bootstraps the ETLayer Cloudflare ingest runtime:

1. verifies Node/npm and Wrangler;
2. verifies local Cloudflare authentication;
3. ensures Queue, DLQ, and R2 resources exist;
4. generates and rotates `ETLAYER_INGEST_KEY`;
5. preserves or securely prompts for `POSTHOG_PROJECT_TOKEN`;
6. deploys `etlayer-ingest`;
7. checks `/health`;
8. sends an OTLP smoke event.

Run from the repository root:

```bash
./scripts/once/bootstrap-cloudflare.sh
```

## deploy-fixture.sh

Deploys the VS1 browser + backend fixture, configures the shared ingest credential, verifies the ETLayer Service Binding, and runs direct plus fixture-mediated OTLP preflights before printing a funnel URL.

```bash
./scripts/once/deploy-fixture.sh
```

## posthog-export-mode.sh

Acceptance-only switch for deliberately disabling or restoring the PostHog projection while canonical R2 persistence continues:

```bash
./scripts/once/posthog-export-mode.sh disable
./scripts/once/posthog-export-mode.sh enable
```

Do not leave projection disabled after an acceptance run.

## replay-posthog.sh

Replays canonical R2 events into PostHog for a half-open UTC interval:

```bash
./scripts/once/replay-posthog.sh \
  --from 2026-09-21T20:34:03Z \
  --to   2026-09-21T20:35:05Z
```

## diagnose-smoke.sh

Low-level diagnostic helper for Queue, R2, Worker logs, and destination projection when the normal smoke path fails.

## Secret handling

These helpers never write secret values into the repository or an `.env` file. Generated ingest/replay keys are passed directly to Wrangler secrets and kept only in process memory.

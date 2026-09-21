# Once / acceptance helpers

These scripts reproduce and diagnose ETLayer's Cloudflare vertical slices.

They are intentionally **not** the long-term ETLayer CLI. Keep them while they remain useful as executable acceptance evidence; replace them with durable provisioning or CLI commands when those interfaces stabilize.

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

```bash
./scripts/once/bootstrap-cloudflare.sh
```

Statsig is intentionally not bootstrapped by this script. VS2 live activation uses a Statsig Server Secret stored only as the Worker secret `STATSIG_SERVER_SECRET`.

## deploy-fixture.sh

Deploys the browser + backend acceptance fixture, configures the shared ingest credential, verifies the ETLayer Service Binding, and runs direct plus fixture-mediated OTLP preflights before printing a funnel URL.

```bash
./scripts/once/deploy-fixture.sh
```

## Destination outage switches

Generic form:

```bash
./scripts/once/export-mode.sh posthog disable
./scripts/once/export-mode.sh posthog enable

./scripts/once/export-mode.sh statsig disable
./scripts/once/export-mode.sh statsig enable
```

Compatibility/convenience wrappers:

```bash
./scripts/once/posthog-export-mode.sh disable
./scripts/once/posthog-export-mode.sh enable

./scripts/once/statsig-export-mode.sh disable
./scripts/once/statsig-export-mode.sh enable
```

Disabling one projection does not disable canonical R2 persistence or the other destination.

Do not leave a destination disabled after an acceptance run.

## Destination-aware replay

Generic form:

```bash
./scripts/once/replay-destination.sh \
  --destination statsig \
  --from 2026-09-22T10:00:00Z \
  --to   2026-09-22T10:05:00Z
```

Convenience wrappers preserve the VS1 PostHog command and add the VS2 Statsig equivalent:

```bash
./scripts/once/replay-posthog.sh \
  --from 2026-09-21T20:34:03Z \
  --to   2026-09-21T20:35:05Z

./scripts/once/replay-statsig.sh \
  --from 2026-09-22T10:00:00Z \
  --to   2026-09-22T10:05:00Z
```

Only the named destination is invoked by a replay.

## diagnose-smoke.sh

Low-level diagnostic helper for Queue, R2, Worker logs, and destination projection when the normal smoke path fails.

## Secret handling

These helpers never write secret values into the repository or an `.env` file. Generated ingest/replay keys are passed directly to Wrangler secrets and kept only in process memory.

Runtime destination secrets:

```text
POSTHOG_PROJECT_TOKEN
STATSIG_SERVER_SECRET
```

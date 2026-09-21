# PostHog acceptance loop

ETLayer's first exporter is not considered complete merely because the destination HTTP request returned success.

The acceptance loop is machine-verifiable:

```text
local smoke producer
        |
      OTLP
        |
     ETLayer
        |
      Queue
        |
        R2
        |
     PostHog
        |
   PostHog MCP
        |
      assert
```

## Local bootstrap

For VS1, deployment intentionally follows the same model used by RunDiff: an authenticated local Wrangler session.

```bash
./scripts/once/bootstrap-cloudflare.sh
```

The helper creates or reuses the Cloudflare resources, rotates the ETLayer ingest key, reuses the PostHog Worker secret when already configured, deploys the Worker, checks `/health`, and emits one `etlayer.acceptance.smoke` OTLP event.

Each smoke is stamped with a unique `etlayer.test.run_id` beginning with `local-`.

No Cloudflare API token or GitHub Actions secret is required for this VS1 bootstrap path.

## Agent verification

After the smoke completes, use the connected PostHog MCP against project `ETLayer`.

First confirm the event and property exist through PostHog schema discovery. Then query the captured event using the emitted `etlayer.test.run_id`.

Assertions:

- the intended smoke event is present;
- `properties['etlayer.event.id']` is present;
- `properties['etlayer.test.run_id']` matches the smoke run;
- the event name is `etlayer.acceptance.smoke`;
- retries do not create uncontrolled logical duplicates.

## Why this is separate from unit tests

Unit tests prove projection and retry behavior in isolation.

The smoke test proves the deployed integration across OTLP JSON, Cloudflare Worker, Cloudflare Queue, R2 persistence, PostHog Capture API, PostHog ingestion, and PostHog MCP queryability.

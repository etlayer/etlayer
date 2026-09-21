# PostHog acceptance loop

ETLayer's first exporter is not considered complete merely because the destination HTTP request returned success.

The acceptance loop is machine-verifiable:

```text
fixture / smoke producer
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

## GitHub Actions setup

The `Deploy and smoke` workflow expects these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `ETLAYER_INGEST_KEY`
- `POSTHOG_PROJECT_TOKEN`

The workflow:

1. ensures the Queue, DLQ, and R2 bucket exist;
2. configures Worker secrets;
3. deploys the Worker;
4. checks `/health`;
5. emits one `etlayer.acceptance.smoke` OTLP event;
6. stamps it with `etlayer.test.run_id=gha-<run-id>-<attempt>`.

## Agent verification

After the workflow completes, use the connected PostHog MCP against the ETLayer project.

First confirm the event and property exist through PostHog schema discovery. Then query the captured event using the emitted `etlayer.test.run_id`.

Assertions:

- exactly the intended smoke event is present for the test run;
- `properties['etlayer.event.id']` is present;
- `properties['etlayer.test.run_id']` matches the GitHub Actions run;
- the event name is `etlayer.acceptance.smoke`;
- retries do not create uncontrolled logical duplicates.

## Why this is separate from unit tests

Unit tests prove projection and retry behavior in isolation.

The smoke test proves the deployed integration across OTLP JSON, Cloudflare Worker, Cloudflare Queue, R2 persistence, PostHog Capture API, PostHog ingestion, and PostHog MCP queryability.

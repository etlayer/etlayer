# Once

Temporary one-time bootstrap helpers live here.

These scripts are intentionally **not** part of the long-term ETLayer CLI. Once the deployment path is stable, delete this directory or replace it with durable provisioning.

## bootstrap-cloudflare.sh

Bootstraps and verifies the first ETLayer Cloudflare vertical slice using the same model we used for RunDiff: **local Wrangler OAuth**, not a GitHub CI API token.

Run from the repository root:

```bash
git switch chore/local-cloudflare-bootstrap
npm install
./scripts/once/bootstrap-cloudflare.sh
```

The script:

1. checks Node/npm;
2. uses the repository-pinned Wrangler;
3. runs `wrangler whoami`, and opens `wrangler login` if needed;
4. ensures these resources exist:
   - `etlayer-events` Queue;
   - `etlayer-events-dlq` dead-letter Queue;
   - `etlayer-events-archive` R2 bucket;
5. generates a fresh random 256-bit `ETLAYER_INGEST_KEY`;
6. securely prompts once for the PostHog **Project API token** for project `ETLayer` unless `POSTHOG_PROJECT_TOKEN` is already in the shell;
7. writes both values directly to Worker secrets with `wrangler secret put`;
8. deploys `etlayer-ingest`;
9. checks `/health`;
10. sends an `etlayer.acceptance.smoke` OTLP event.

No Cloudflare API token is required because deployment runs from your authenticated local Wrangler session.

### Optional non-interactive PostHog token

```bash
export POSTHOG_PROJECT_TOKEN='phc_...'
./scripts/once/bootstrap-cloudflare.sh
```

The script never writes secret values to the repository or to an `.env` file.

### Important

Rerunning the script generates a **new** `ETLAYER_INGEST_KEY` and replaces the Worker secret. That is intentional for this disposable bootstrap helper.

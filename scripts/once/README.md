# Once

Temporary one-time bootstrap helpers live here.

These scripts are intentionally **not** part of the long-term ETLayer CLI. Once the deployment path is stable, delete this directory or replace it with durable provisioning.

## bootstrap-cloudflare.sh

Bootstraps and verifies the first ETLayer Cloudflare vertical slice using the same model as RunDiff: **local Wrangler OAuth**, not a GitHub CI API token.

Run from the repository root:

```bash
git switch chore/local-cloudflare-bootstrap
git pull --ff-only
rm -f package-lock.json
./scripts/once/bootstrap-cloudflare.sh
```

The script:

1. checks Node/npm;
2. uses the repository-pinned Wrangler;
3. runs `wrangler whoami`, and opens `wrangler login` if needed;
4. ensures the Queue, DLQ, and R2 bucket exist;
5. generates a fresh random 256-bit `ETLAYER_INGEST_KEY`;
6. updates that Worker secret;
7. reuses the existing `POSTHOG_PROJECT_TOKEN` Worker secret when present;
8. otherwise securely prompts once for the PostHog Project API token;
9. deploys `etlayer-ingest`;
10. checks `/health`;
11. sends an `etlayer.acceptance.smoke` OTLP event.

No `CLOUDFLARE_API_TOKEN` is required because deployment runs from your authenticated local Wrangler session.

The script never writes secret values to the repository or to an `.env` file. Re-running it intentionally rotates only the ETLayer ingest key.

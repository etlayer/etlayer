# Once

This directory contains **one-time bootstrap helpers**.

These scripts are intentionally temporary. They automate setup that should not become part of ETLayer's long-term runtime or public CLI.

Once a bootstrap flow is stable and no longer needed, delete or replace the script with a durable provisioning mechanism.

## setup-github-secrets.sh

Configures the GitHub Actions repository secrets required by the first Cloudflare + PostHog vertical slice.

It:

1. verifies or installs GitHub CLI on macOS when Homebrew is available;
2. authenticates GitHub CLI if needed;
3. installs repository dependencies so the pinned Wrangler is available;
4. authenticates Wrangler through Cloudflare OAuth if needed;
5. attempts to discover the Cloudflare Account ID from `wrangler whoami`;
6. securely prompts for a scoped Cloudflare API token if it is not already in the environment;
7. securely prompts for the PostHog ETLayer Project API token if it is not already in the environment;
8. generates a fresh 256-bit `ETLAYER_INGEST_KEY` locally;
9. writes all four values to GitHub repository secrets through `gh secret set`.

It does **not** write secret values into the repository or an `.env` file.

Run from the repository root:

```bash
chmod +x scripts/once/setup-github-secrets.sh
./scripts/once/setup-github-secrets.sh
```

Optional environment variables:

```bash
export CLOUDFLARE_API_TOKEN='...'
export POSTHOG_PROJECT_TOKEN='phc_...'
./scripts/once/setup-github-secrets.sh
```

The script cannot safely mint a new Cloudflare CI API token from Wrangler's local OAuth session, nor can it mint a PostHog project token without an already-authorized API credential. Those two values therefore require one secure paste unless already present in the environment.

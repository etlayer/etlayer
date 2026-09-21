# Cloudflare fixture

A deliberately tiny external consumer for ETLayer VS1.

It proves that a browser interaction event and a backend business event can use the same ETLayer OTLP/HTTP ingest path without embedding a destination SDK.

## Flow

```text
Browser
  |
  +-- landing.hero.exposed
  +-- landing.hero.cta_clicked
  |
  v
Fixture Worker proxy
  |
  | OTLP/HTTP
  v
ETLayer /v1/logs

Fixture Worker
  |
  +-- account.created
  |
  | OTLP/HTTP
  v
ETLayer /v1/logs
```

The browser uses a same-origin proxy so the ETLayer ingest credential is never exposed to client-side JavaScript.

## Configure

Set the ETLayer endpoint:

```bash
npx wrangler secret put ETLAYER_INGEST_KEY
```

Then set `ETLAYER_OTLP_ENDPOINT` in `wrangler.jsonc` or override it for your deployment.

The endpoint should include the OTLP logs path, for example:

```text
https://events.example.com/v1/logs
```

## Run locally

```bash
npx wrangler dev
```

Open the local URL.

The page automatically emits:

```text
landing.hero.exposed
```

Click **Try ETLayer** to emit:

```text
landing.hero.cta_clicked
```

Click **Create test account** to make the Worker emit:

```text
account.created
```

## Intentional limitations

This fixture is not an SDK example.

It intentionally contains a tiny OTLP JSON encoder so it can test the protocol boundary independently of future ETLayer helper libraries.

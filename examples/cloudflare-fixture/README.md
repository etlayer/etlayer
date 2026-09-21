# Cloudflare fixture

A deliberately small external consumer for ETLayer VS1.

It proves that browser interaction events and a backend-authoritative business event can use the same ETLayer OTLP/HTTP ingest path without embedding a destination SDK.

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
  | OTLP/HTTP over Cloudflare Service Binding
  v
ETLayer /v1/logs

Fixture backend
  |
  +-- persist account -> R2 fixture state
  +-- account.created
  |
  | OTLP/HTTP
  v
ETLayer /v1/logs
```

The browser uses a same-origin proxy so the ETLayer ingest credential is never exposed to client-side JavaScript.

## Identity and causality

A stable anonymous actor is kept in an HttpOnly cookie. Each acceptance run gets one `correlation.id`.

The browser keeps the returned ETLayer event IDs only long enough to form the causal chain:

```text
hero exposure event id
        |
        v
CTA causation.id
        |
        v
account.created causation.id
```

The backend does not trust the browser to declare that an account exists. It writes the account state first and emits `account.created` itself.

## Deploy the VS1 fixture

From the repository root:

```bash
./scripts/once/deploy-fixture.sh
```

The script prints a one-time URL with the acceptance `correlation.id`.

Open that URL. The page automatically emits the hero exposure, then enables the CTA, then enables account creation after the CTA succeeds.

## Intentional limitations

This fixture is not an SDK example and not a production identity system.

It intentionally contains a tiny OTLP JSON encoder so it can test the protocol boundary independently of future ETLayer helper libraries.


## Cloudflare Worker-to-Worker transport

The deployed fixture uses a Cloudflare Service Binding named `ETLAYER` targeting the `etlayer-ingest` Worker.

The application-level protocol remains OTLP/HTTP: the fixture constructs the same authenticated `POST /v1/logs` request, but delivers it through `env.ETLAYER.fetch(request)` rather than making a public `workers.dev` network hop.

This matters because same-account Worker-to-Worker communication on `workers.dev` is expected to use Service Bindings.

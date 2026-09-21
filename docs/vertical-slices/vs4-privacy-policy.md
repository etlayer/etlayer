# VS4: Privacy policy and field classification

**Status: In progress.**

## Goal

Make ETLayer the privacy boundary for product and business event telemetry.

VS4 introduces deterministic field classification with enforcement at two lifecycle stages:

```text
OTLP ingest
  |
  v
ingest privacy scrub
  |  secret/credential material -> drop
  v
Queue
  |
  v
canonical R2
  |
  v
contract validation
  |
  v
delivery privacy projection
  |  direct identifiers -> drop
  v
destination router
  |       |
PostHog  Statsig
```

## Why two stages

Not every sensitive field has the same lifecycle.

### Secrets

Credential material such as tokens, passwords, authorization headers, and cookies should not become durable telemetry at all.

VS4 removes those fields before the event is queued.

Therefore:

```text
producer payload contains auth.token
        |
        v
OTLP ingest privacy scrub
        |
        +--> privacy evidence: auth.token / secret / drop
        |
        v
Queue + canonical R2 contain no auth.token value
```

### Direct identifiers

Some direct identifiers can be intentionally part of ETLayer's canonical source of truth while still being inappropriate for downstream analytics.

VS4 starts with `user.email`.

Therefore:

```text
canonical R2        user.email preserved
destination router  user.email absent
```

This keeps ETLayer—not PostHog or Statsig—as the privacy boundary.

## Policy v1 classifications

The initial policy supports:

- `secret`
- `direct_identifier`
- `pseudonymous_identifier`
- `operational`
- `product_context`
- `unclassified`

Reference mappings:

```text
user.email                direct_identifier
user.phone                direct_identifier
user.id                   pseudonymous_identifier
actor.anonymous.id        pseudonymous_identifier
account.id                pseudonymous_identifier
session.id                pseudonymous_identifier
correlation.id            operational
causation.id              operational
etlayer.event.id          operational
etlayer.schema.version    operational
experiment.*              product_context
page.*                    product_context
cta.*                     product_context
```

Credential-like field names are classified as `secret` using a small deterministic key-name matcher.

## Policy v1 actions

```text
classification             ingest       destination
----------------------------------------------------
secret                     drop         drop
direct_identifier          preserve     drop
pseudonymous_identifier    preserve     pass
operational                preserve     pass
product_context            preserve     pass
unclassified               preserve     pass
```

The destination action is global in VS4. Destination-specific policies are intentionally deferred.

## Privacy evidence

Privacy lifecycle evidence is written separately:

```text
privacy/<event-id>.json
```

Example:

```json
{
  "version": 1,
  "eventId": "event-id",
  "eventName": "account.created",
  "policyVersion": 1,
  "status": "applied",
  "sourceKey": "events/.../event-id.json",
  "ingestActions": [
    {
      "location": "logRecord",
      "attribute": "auth.token",
      "classification": "secret",
      "action": "drop"
    }
  ],
  "deliveryActions": [
    {
      "location": "logRecord",
      "attribute": "user.email",
      "classification": "direct_identifier",
      "action": "drop"
    }
  ]
}
```

No removed secret value is copied into privacy evidence.

## Acceptance event

VS4 uses a valid `account.created@1` carrying two extra attributes:

```text
user.email = acceptance@example.test
auth.token = acceptance-secret-do-not-store
```

Expected lifecycle:

```text
producer             email ✓   token ✓
Queue                email ✓   token ✗
canonical R2         email ✓   token ✗
validation           valid
privacy evidence     email drop + token ingest drop
PostHog              email ✗   token ✗
Statsig projection   email ✗   token ✗
```

## Acceptance

1. Policy v1 is executable and deterministic.
2. Common secret/credential key names are recognized.
3. `auth.token` is removed before Queue enqueue.
4. Canonical R2 contains no `auth.token`.
5. Canonical R2 still contains `user.email`.
6. The event remains valid under `account.created@1`.
7. Privacy state records the ingest secret drop without recording the secret value.
8. Privacy state records the delivery drop for `user.email`.
9. PostHog receives the logical event without either sensitive field.
10. Statsig receives the same privacy-sanitized logical event.
11. Normal existing funnel behavior remains unchanged.
12. Revalidation reapplies current delivery privacy policy to the canonical event.

## Non-goals

VS4 does not include:

- machine-learning PII detection;
- destination-specific policy DSL;
- per-tenant policies;
- consent management;
- encryption/key management;
- DSR/deletion workflows;
- automatic hashing or tokenization;
- identity graph;
- remote privacy policy fetching;
- recovery of secret values intentionally removed at ingest.

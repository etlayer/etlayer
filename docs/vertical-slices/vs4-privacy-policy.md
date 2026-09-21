# VS4: Privacy policy and field classification

**Status: Complete — live privacy acceptance passed on 2026-09-21.**

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
## Implementation status

### VS4.1 — Privacy enforcement core — complete

- executable privacy policy v1 added;
- deterministic field classification added;
- credential-like secret fields are scrubbed before Queue enqueue;
- canonical events retain ingest privacy evidence without secret values;
- direct identifiers are removed from the copy passed to the destination router;
- durable privacy state is stored under `privacy/<event-id>.json`;
- blocked VS3 events still record privacy evidence but do not route;
- revalidation reapplies delivery privacy policy;
- normal unversioned migration events also pass through privacy enforcement;
- acceptance fixture can emit a valid authoritative `account.created@1` containing `user.email` + fake `auth.token`;
- `scripts/once/vs4-privacy-account.sh` verifies canonical/storage/delivery invariants.

### VS4.2 — Live acceptance — complete

- deployed the VS4 branch and fixture;
- ran the normal three-event funnel and observed no regression;
- ran `./scripts/once/vs4-privacy-account.sh`;
- verified canonical R2 preserved `user.email`;
- verified `auth.token` and the secret literal were absent from canonical R2;
- verified contract validation remained `valid`;
- verified privacy evidence recorded both policy actions;
- verified PostHog stored the privacy acceptance event without `user.email` or `auth.token`;
- verified Statsig delivery state was `exported` for the same privacy-sanitized logical event.

## Live acceptance evidence

### Normal funnel regression check

Correlation:

```text
acceptance-20260921T230603Z-7c984378
```

Logical events:

```text
225123d8-1e67-4dd5-a1b5-e462e12e30fc  landing.hero.exposed
774295a1-c342-4161-8939-debb3a6cbd14  landing.hero.cta_clicked
ba0d1418-94f2-452d-adb2-c713e0cf2897  account.created
```

PostHog independently showed exactly one row for each logical event.

### Privacy acceptance event

Correlation:

```text
vs4-privacy-20260921T230945Z-583659c6
```

Event:

```text
20da3f3f-2936-4edd-a880-8cabac66bbe9  account.created@1
```

Acceptance-only sensitive fields emitted by the producer:

```text
user.email = acceptance@example.test
auth.token = acceptance-secret-do-not-store
```

Canonical R2:

```text
user.email                 preserved
auth.token                 absent
secret literal             absent
```

Canonical source:

```text
events/2026/09/21/23/20da3f3f-2936-4edd-a880-8cabac66bbe9.json
```

Contract validation:

```text
status       valid
contract     account.created@1
errors       []
```

Privacy evidence:

```text
policyVersion  1
status         applied

ingest:
  auth.token
  classification=secret
  action=drop

delivery:
  user.email
  classification=direct_identifier
  action=drop
```

Destination outcomes:

```text
PostHog delivery state  exported
Statsig delivery state  exported
```

An independent PostHog query showed exactly one row for the privacy event, with both:

```text
user.email  absent/null
auth.token  absent/null
```

PostHog's project taxonomy also had no known `user.email` or `auth.token` property entries at verification time.

This proves:

- secret/credential-like attributes can be removed before Queue and durable canonical storage;
- ETLayer can retain a direct identifier canonically while withholding it from downstream analytics;
- privacy enforcement is independent of producer instrumentation and destination SDKs;
- contract validation remains intact after ingest privacy scrubbing;
- privacy lifecycle evidence is durable and does not copy removed secret values;
- PostHog and Statsig can still receive the same logical event after privacy projection;
- normal product-event routing remains unchanged.

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

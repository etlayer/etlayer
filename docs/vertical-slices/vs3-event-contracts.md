# VS3: Event contracts and schema governance

**Status: Complete — live contract-governance acceptance passed on 2026-09-21.**

## Goal

Make product and business event contracts executable ETLayer policy.

VS1 proved durable preservation and replay. VS2 proved multi-destination routing, failure isolation, and destination-aware recovery. VS3 adds the semantic boundary between those two layers:

```text
producer
   |
   v
OTLP ingest
   |
   v
Queue
   |
   v
canonical R2 event
   |
   v
contract validation
   |                 \
   | valid            \ blocked
   v                   v
destination router    durable validation evidence
  |       |            no downstream projection
  v       v
PostHog  Statsig
```

## Preserve first

Contract enforcement happens **after** canonical persistence.

If a versioned event violates its contract:

```text
canonical event   preserved
validation        blocked
PostHog           not invoked
Statsig           not invoked
```

ETLayer therefore does not lose evidence simply because policy rejected a destination projection.

## Contract source of truth

The initial source format is a pure-data ES module:

```text
packages/cloudflare-ingest/contracts/
  landing.hero.exposed.v1.js
  landing.hero.cta_clicked.v1.js
  account.created.v1.js
```

Each module exports data only; there is no executable policy code inside an individual contract.

This keeps contracts directly loadable in both Node tests and the Cloudflare Worker without a YAML/JSON parser dependency or build-time code generation.

## Migration policy

Contract enforcement is opt-in through:

```text
etlayer.schema.version
```

Lifecycle:

```text
no schema version
  -> unmanaged
  -> durable validation state
  -> routing continues

schema version + matching contract
  -> validate
  -> valid  -> routing continues
  -> blocked -> no destination routing

schema version + no matching contract
  -> blocked
```

This migration rule keeps existing unversioned smoke/admin telemetry working while product/business events move to explicit contracts.

## V1 contract vocabulary

VS3 supports only the minimum vocabulary needed by the reference funnel:

- event name;
- schema version;
- required attributes;
- primitive attribute types;
- exact-value constraints;
- forbidden attributes.

No general expression language is introduced.

## Initial contracts

### landing.hero.exposed v1

Requires:

- `actor.anonymous.id: string`
- `correlation.id: string`
- `etlayer.producer.kind = browser`
- `etlayer.authority.kind = interaction`
- `experiment.id: string`
- `experiment.variant: string`

### landing.hero.cta_clicked v1

Requires the exposure attributes plus:

- `causation.id: string`

### account.created v1

Requires:

- `actor.anonymous.id: string`
- `account.id: string`
- `correlation.id: string`
- `causation.id: string`
- `etlayer.producer.kind = backend`
- `etlayer.authority.kind = business_state`

Forbids:

- `experiment.id`
- `experiment.variant`

## Durable validation state

Validation outcome is stored separately from the immutable canonical event:

```text
validation/<event-id>.json
```

Example blocked state:

```json
{
  "version": 1,
  "eventId": "event-id",
  "eventName": "account.created",
  "schemaVersion": 1,
  "status": "blocked",
  "contractId": "account.created@1",
  "errors": [
    {
      "code": "required_attribute_missing",
      "attribute": "account.id"
    }
  ]
}
```

Validation state is mutable lifecycle evidence. The canonical event remains immutable.

## Acceptance

1. The three fixture events have executable v1 contracts.
2. Existing happy-path fixture events validate successfully.
3. Canonical persistence occurs before validation.
4. A valid versioned event records `status=valid`.
5. An unversioned event records `status=unmanaged` and continues routing.
6. A versioned event with no matching contract records `status=blocked`.
7. A deliberately invalid `account.created` without `account.id` is still canonically preserved.
8. That invalid event records a machine-readable validation error.
9. That invalid event never invokes PostHog.
10. That invalid event never invokes Statsig.
11. Validation is deterministic under repeated processing.
12. The same preserved event can be revalidated later without producer involvement.

## Implementation status

### VS3.1 — Contract enforcement core — complete

- versioned pure-data contracts exist for the three reference fixture events;
- `validateEventContract()` enforces required attributes, primitive types, exact values, and forbidden attributes;
- unversioned events are recorded as `unmanaged` during migration;
- versioned events without a matching contract are blocked;
- validation outcome is persisted under `validation/<event-id>.json`;
- blocked events do not invoke destination routing;
- validation-state persistence failure remains retryable through the existing queue lifecycle;
- integration coverage proves canonical persistence occurs before validation evidence and blocking.

### VS3.2 — Live acceptance — complete

- deployed the VS3 branch and fixture;
- proved the existing three-event funnel remained valid;
- verified all three validation states were `valid` with their expected contract IDs;
- verified all three valid events reached Statsig and PostHog;
- emitted one deliberately invalid `account.created@1` without `account.id`;
- proved the invalid event was canonically preserved in R2;
- proved validation was `blocked` with the exact error `required_attribute_missing/account.id`;
- proved PostHog and Statsig delivery state were both absent for the blocked event;
- reread and revalidated the same canonical `sourceKey` without producer re-emission;
- proved the preserved invalid event remained blocked with zero deliveries.

## Live acceptance evidence

### Valid contract-governed funnel

Correlation:

```text
acceptance-20260921T222121Z-9cfd4279
```

Events:

```text
1747aa48-c84d-4c8f-a42a-e469be99c2fe  landing.hero.exposed
47645593-93a9-46c4-8ed0-c7089cf2dc34  landing.hero.cta_clicked
bc0b594d-31d8-46fa-9ee4-ab63054fbe93  account.created
```

Durable validation states:

```text
landing.hero.exposed      -> valid -> landing.hero.exposed@1
landing.hero.cta_clicked  -> valid -> landing.hero.cta_clicked@1
account.created           -> valid -> account.created@1
```

Statsig delivery state for all three logical events was `exported`.

An independent PostHog query showed exactly the same three logical events with one actor and the expected causation chain.

### Blocked invalid business event

Correlation:

```text
vs3-invalid-account-20260921T222202Z-0adfd840
```

Event:

```text
ac8bacdb-a865-416d-8736-54e6d58a5e4c  account.created@1
```

The event intentionally omitted only:

```text
account.id
```

ETLayer accepted and canonically preserved the event at:

```text
events/2026/09/21/22/ac8bacdb-a865-416d-8736-54e6d58a5e4c.json
```

Validation evidence:

```json
{
  "status": "blocked",
  "schemaVersion": 1,
  "contractId": "account.created@1",
  "errors": [
    {
      "code": "required_attribute_missing",
      "attribute": "account.id"
    }
  ]
}
```

Destination state:

```text
PostHog delivery state  absent
Statsig delivery state  absent
```

An independent PostHog query also returned zero rows for the invalid correlation.

### Canonical revalidation without producer re-emission

The preserved canonical `sourceKey` was passed to the protected revalidation operator.

The result was:

```text
eventId      ac8bacdb-a865-416d-8736-54e6d58a5e4c
eventName    account.created
validation   blocked
contract     account.created@1
deliveries   []
```

The exact validation error remained:

```text
required_attribute_missing / account.id
```

No producer emitted a second logical event.

This proves:

- ETLayer preserves accepted events before governance;
- versioned contracts are executable runtime policy, not documentation;
- malformed product/business events can be blocked before contaminating downstream systems;
- validation outcomes are durable and machine-readable;
- valid events continue to route normally;
- preserved events can be revalidated later without producer involvement.

## Non-goals

VS3 does not include:

- schema registry UI;
- YAML authoring support;
- JSON Schema compatibility;
- Avro/Protobuf schema registry integration;
- privacy/PII classification;
- identity graph;
- arbitrary expressions;
- remote contract fetching;
- tenant-specific contracts;
- automatic schema evolution heuristics.

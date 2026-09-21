# VS3: Event contracts and schema governance

**Status: In progress.**

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

# VS23: Bounded Governance Metrics

**Status: implementation in progress.**

Tracks GitHub issue #82.

Classification:

~~~text
A2-NOW-GOV/OPS
Core - medium effort - do now
Governance + Operations
~~~

## Risk

ETLayer now preserves durable validation, Decision, Delivery/Attempt, contract lifecycle, and ownership evidence.

Before VS23 an operator still has to inspect events one by one to answer basic questions such as:

~~~text
what percentage of events are quarantined?
how many current contracts are deprecated?
how much of this traffic has a current owner?
are delivery failures accumulating?
~~~

A dashboard built before a supported aggregate boundary would either duplicate ETLayer storage semantics client-side or create a second analytics truth too early.

## Target invariant

~~~text
durable ETLayer evidence
  -> bounded read-only aggregate
  -> counts + rates

same project + same evidence + same range
  -> same response

metrics
  != source of truth
  != write-side counters
  != analytics warehouse
~~~

## API

Project-operator authenticated endpoint:

~~~text
POST /_ops/governance/metrics
Authorization: Bearer <project-operator>
Content-Type: application/json
~~~

Request:

~~~json
{
  "projectId": "customer-a",
  "from": "2026-09-26T10:00:00Z",
  "to": "2026-09-26T11:00:00Z",
  "maxEvents": 500,
  "eventName": "account.created"
}
~~~

`eventName` is optional.

`maxEvents` defaults to 500 and is hard-bounded at 5000.

## Read model

VS23 reuses existing authoritative readers:

~~~text
canonical event range selection
  -> selectArchivedEvents

per-event evidence
  -> inspectEventState

current ownership inventory
  -> readContractOwnership

current contract lifecycle inventory
  -> readContractLifecycle
~~~

No aggregate object is persisted.

No write-side counter is introduced.

## Response semantics

The response deliberately separates two different time semantics.

### eventWindow

`eventWindow` is scoped to the requested canonical-event time range.

It includes:

~~~text
selected

validation
  valid
  quarantined
  blocked
  unknown
  validRate
  quarantineRate

decisions
  allow
  block
  quarantine
  unknown
  allowRate
  blockRate
  quarantineRate

ownership
  owned
  unowned
  coverageRate
  teamCount
  teams

delivery.summaries
  total
  exported
  skipped
  failed
  not_routed
  pending
  unknown
  exportedRate

delivery.attempts
  total
  exported
  skipped
  failed
  unknown
  exportedRate
~~~

Ownership in the event window means **current ownership for the selected event semantic**, because VS22 ownership is intentionally current operational metadata rather than historical Decision lineage.

### currentGovernance

`currentGovernance` is a current project inventory, not windowed historical state.

It includes:

~~~text
ownership
  resources
  teamCount
  teams

lifecycle
  total
  published
  deprecated
  retired
~~~

That distinction is explicit so consumers do not mistake current contract governance for historical event evaluation state.

## Rates

Rates are deterministic decimal fractions:

~~~text
0 <= rate <= 1
~~~

and are rounded to six decimal places.

A zero denominator produces:

~~~text
0
~~~

rather than NaN or Infinity.

## Determinism

VS23 intentionally does not include a generatedAt/asOf timestamp in the response.

If durable evidence and the requested range are unchanged, two calls return the same JSON representation.

This makes the endpoint suitable for:

- CI assertions;
- incident tooling;
- lightweight dashboard polling;
- future cache/ETag layers.

## Bounds

Event work:

~~~text
default maxEvents  500
hard maxEvents     5000
~~~

Current governance inventory is separately bounded to 5000 ownership/lifecycle resources per scanned prefix.

If a bound is exceeded, the caller must narrow the request or a later materialized metrics architecture must be introduced.

This is intentional pressure against silently turning R2 scans into an analytics system.

## Security

The endpoint uses the existing project-operator authentication boundary.

A credential for project B cannot request project A metrics.

The metrics response contains no credentials or encrypted secret material.

## Read-only guarantee

The endpoint only reads existing evidence.

It must not create or mutate:

- canonical events;
- validation state;
- authority state;
- privacy state;
- identity state;
- Decision history;
- Delivery summaries;
- Delivery Attempts;
- governance manifests;
- contract lifecycle;
- ownership resources.

## Executable acceptance

The fast VS23 Cloudflare acceptance:

1. creates an isolated dynamic project;
2. creates a backend producer;
3. configures current ownership for account.created;
4. emits one valid account.created@1 event;
5. emits one account.created@1 event missing account.id and proves QUARANTINE;
6. publishes account.created@2 through the guarded VS20 path;
7. deprecates v2 through VS21;
8. queries governance metrics over the two-event range;
9. proves selected=2;
10. proves validation valid=1/quarantined=1;
11. proves Decision allow=1/quarantine=1;
12. proves ownership coverage=1;
13. proves current governance has one ownership resource and one Deprecated contract lifecycle;
14. proves Delivery summary and Attempt totals are zero for the no-destination project;
15. reads the same metrics again and proves byte-identical deterministic output;
16. queries an empty future range and proves every rate remains finite zero;
17. re-inspects both events and proves Decision IDs are unchanged and no Delivery evidence was created;
18. proves a different project operator receives 401.

After merge, the full regression extends the accumulated runtime proof to VS8 -> VS23.

## Non-goals

VS23 does not include:

- persisted time series;
- dashboard/UI;
- Prometheus/OpenTelemetry metrics export;
- arbitrary dimensions/group-by;
- warehouse/OLAP;
- billing metrics;
- latency percentiles;
- SLO engine;
- alerts;
- materialized write-side counters.

Those should only be introduced when scale or a concrete hosted-product use case makes bounded evidence aggregation insufficient.

# VS25: Supported Project Read Surface

**Status: implementation in progress.**

Tracks GitHub issue #90.

Classification:

~~~text
A1-NOW-PRDT/API
Core - small effort - do now
Product + API
~~~

## Risk

ETLayer already exposes public onboarding and event status, but it has no supported project-level read endpoint.

Without one, any UI or CLI project overview would have to depend on internal surfaces:

~~~text
/_mgmt
/_ops
R2 registry keys
implementation modules
~~~

That would turn storage and operator internals into accidental product contracts.

## Target invariant

~~~text
project operator
  -> GET /api/v1/projects/:projectId
  -> stable explicit non-secret project summary

UI / CLI
  != /_mgmt
  != /_ops
  != R2 knowledge
~~~

## Public API

~~~text
GET /api/v1/projects/:projectId
Authorization: Bearer <project-operator>
~~~

Response:

~~~json
{
  "apiVersion": "v1",
  "project": {
    "id": "customer-a",
    "status": "active",
    "source": "registry",
    "createdAt": "2026-09-26T17:00:00.000Z",
    "updatedAt": "2026-09-26T17:05:00.000Z"
  },
  "destinations": [
    "posthog"
  ],
  "governance": {
    "ownership": {
      "resources": 1,
      "teams": [
        "accounts-platform"
      ],
      "teamCount": 1
    },
    "lifecycle": {
      "total": 1,
      "published": 0,
      "deprecated": 1,
      "retired": 0
    }
  },
  "links": {
    "self": "https://events.example/api/v1/projects/customer-a",
    "onboarding": "https://events.example/api/v1/projects/customer-a/onboarding",
    "eventStatusTemplate": "https://events.example/api/v1/projects/customer-a/events/{eventId}",
    "ingest": "https://events.example/v1/logs"
  }
}
~~~

## Explicit field selection

The project response is not a sanitized dump of registry state.

It is assembled field by field.

Exposed project fields:

~~~text
id
status
source
createdAt
updatedAt
~~~

Exposed project destinations:

~~~text
destination names only
~~~

Exposed governance state:

~~~text
current ownership resource count
current owner team names/count
current lifecycle counts
~~~

Not exposed:

~~~text
operatorFingerprint
credentialFingerprint
secretEnv
destination credentials
ciphertext
IV
R2 keys
management URLs
ops URLs
raw ownership contact values
~~~

This is the product boundary.

## Dynamic and static projects

Dynamic registry projects return:

~~~text
source = registry
createdAt = persisted project timestamp
updatedAt = persisted project timestamp
~~~

Static compatibility projects return:

~~~text
source = static
createdAt = null
updatedAt = null
~~~

Static secret-environment names and ingest profile internals are never surfaced.

## Governance summary reuse

VS25 reuses the current governance inventory reader created for VS23.

Therefore:

~~~text
one ownership/lifecycle interpretation
  -> Governance Metrics
  -> Project Read Surface
~~~

There is no second implementation of ownership or lifecycle aggregation.

The project endpoint exposes only current governance inventory.

It does not expose historical event-window metrics.

## Links

VS25 returns links only to supported public or protocol boundaries:

~~~text
GET  /api/v1/projects/:projectId
POST /api/v1/projects/:projectId/onboarding
GET  /api/v1/projects/:projectId/events/{eventId}
POST /v1/logs
~~~

It never advertises:

~~~text
/_mgmt
/_ops
~~~

A future UI/CLI can therefore navigate supported surfaces without knowing internal endpoints.

## Authentication

The endpoint reuses the existing project-operator public API authentication semantics.

~~~text
correct project operator
  -> 200

operator for another project
  -> 401 invalid_operator_credential

unknown project
  -> 404 project_not_found
~~~

## Read-only semantics

Project reads derive current state from:

~~~text
project configuration
current destinations
current ownership
current contract lifecycle
~~~

They do not mutate any source.

For unchanged current state, repeated reads are deterministic.

## Executable acceptance

The fast VS25 Cloudflare acceptance:

1. deploys the current Worker;
2. creates an isolated dynamic project;
3. reads the public project surface before onboarding;
4. proves destination/governance state is initially empty;
5. proves the response exposes no internal or secret fields;
6. onboards one backend producer and PostHog destination through the supported public onboarding API;
7. configures ownership;
8. plans and publishes account.created@2;
9. deprecates account.created@2;
10. reads the project twice;
11. proves both responses are byte-identical for unchanged state;
12. proves PostHog is now visible as the current destination;
13. proves one ownership resource and accounts-platform team are visible;
14. proves one Deprecated lifecycle resource is visible;
15. proves ownership contact values and credential/internal fields are absent;
16. proves all returned links are supported public/OTLP routes;
17. creates another project and proves its operator cannot read the first project;
18. proves an unknown project returns stable public 404 semantics.

After merge, full regression extends the accumulated runtime proof to VS8 -> VS25.

## Non-goals

VS25 does not include:

- project list;
- producer list;
- event list/search;
- destination credential status;
- public historical Governance Metrics;
- mutation APIs;
- workspace/account model;
- RBAC;
- UI.

Those can build on this supported project-level read boundary when the product requires them.

# VS8: Project-scoped configuration and isolation

**Status: implementation complete; live Cloudflare acceptance pending.**

## Goal

Allow one ETLayer runtime to safely serve multiple independently configured projects without allowing producer payloads, storage keys, routing, replay, or revalidation to cross project boundaries.

## Core invariant

```text
payload cannot choose project
credential resolves project
project scopes policy, storage, routing, replay, and revalidation
```

VS8 is intentionally configuration-first. It does not introduce a hosted control plane or database-backed project CRUD.

## Reference projects

The Cloudflare reference runtime defines two projects:

```text
etlayer-default
  producers:
    browser
    backend
    agent-runtime
    legacy
  destinations:
    posthog
    statsig
  operator secret:
    ETLAYER_REPLAY_KEY

etlayer-secondary
  producers:
    backend
  destinations:
    posthog
  operator secret:
    ETLAYER_SECONDARY_REPLAY_KEY
```

These project IDs are reference-runtime configuration, not a universal tenancy hierarchy.

## Trusted project provenance

New accepted events receive provenance v2:

```json
{
  "provenance": {
    "version": 2,
    "projectId": "etlayer-default",
    "profileId": "backend",
    "authentication": "bearer_profile",
    "producer": {
      "kind": "backend"
    },
    "allowedAuthorityKinds": [
      "business_state"
    ]
  }
}
```

The project ID is derived from the authenticated ingest credential.

A producer attribute such as:

```text
etlayer.project.id = etlayer-secondary
```

is an untrusted claim. It never chooses the storage namespace, routing configuration, replay scope, or operator scope.

Pre-VS8 provenance v1 remains readable as historical data and maps to the original default project namespace.

## Physical storage isolation

All new durable ETLayer evidence is stored under:

```text
projects/<project-id>/
```

including:

```text
projects/<project-id>/events/...
projects/<project-id>/validation/...
projects/<project-id>/authority/...
projects/<project-id>/privacy/...
projects/<project-id>/identity/...
projects/<project-id>/decisions/...
projects/<project-id>/decision-latest/...
projects/<project-id>/deliveries/...
```

The same logical event ID can therefore exist independently in two projects without an archive identity conflict.

## Destination routing

Destination selection is resolved from trusted project configuration.

Current reference mapping:

```text
etlayer-default
  -> posthog
  -> statsig

etlayer-secondary
  -> posthog
```

The secondary project cannot route or replay Statsig.

Destination projections also stamp trusted:

```text
etlayer.project.id
```

after decoding producer attributes, so producer-supplied project claims cannot override the trusted project in PostHog or Statsig.

## Operator isolation

Replay and revalidation requests now require:

```json
{
  "projectId": "etlayer-default",
  "...": "..."
}
```

The operator credential is resolved per project.

Therefore:

```text
default operator key
+ projectId=etlayer-secondary
-> 401

default operator key
+ projectId=etlayer-default
+ secondary sourceKey
-> 400

secondary operator key
+ secondary canonical sourceKey
-> allowed
```

Revalidation additionally verifies that the canonical event's trusted project matches the requested project.

Replay:

- lists only `projects/<project-id>/events/...`;
- rejects archive objects whose trusted project does not match;
- rejects destinations not enabled for the project;
- reads/writes project-scoped delivery state.

## Isolated Cloudflare CI environment

Automated live acceptance uses a separate named Wrangler environment:

```text
env.ci
```

Wrangler named environments create separate Worker scripts while bindings and variables are declared explicitly per environment.

The reference CI resources are:

```text
etlayer-ingest-ci
etlayer-cloudflare-fixture-ci
etlayer-events-ci
etlayer-events-ci-dlq
etlayer-events-archive-ci
etlayer-fixture-state-ci
```

This keeps branch deployment, rotating acceptance credentials, queue traffic, fixture state, and canonical R2 evidence separate from the default ETLayer runtime.

Bootstrap is intentionally local and one-time:

```bash
./scripts/once/bootstrap-cloudflare-ci.sh
```

Persistent destination credentials stay in Cloudflare Worker secrets. GitHub Actions receives only the Cloudflare deployment credential and account ID.

## Live acceptance

Run after checking out the VS8 branch and ensuring the existing Cloudflare resources and destination secrets are present:

```bash
./scripts/once/vs8-project-isolation.sh
```

The helper is self-contained for credentials. It rotates:

```text
ETLAYER_BROWSER_INGEST_KEY
ETLAYER_BACKEND_INGEST_KEY
ETLAYER_SECONDARY_BACKEND_INGEST_KEY
ETLAYER_REPLAY_KEY
ETLAYER_SECONDARY_REPLAY_KEY
```

and keeps the default fixture browser/backend credentials synchronized.

It then proves:

1. one shared event ID is accepted under both project namespaces;
2. default browser provenance remains `etlayer-default` even when payload claims secondary;
3. secondary backend provenance remains `etlayer-secondary` even when payload claims default;
4. the default browser copy is contract-valid but authority-blocked;
5. the secondary backend copy is authority-allowed;
6. both canonical events exist under different project-prefixed source keys;
7. default blocked delivery state is absent;
8. secondary routing creates PostHog delivery state but no Statsig delivery state;
9. a separate default backend event routes to both PostHog and Statsig;
10. decision-latest pointers for the shared event remain isolated by project;
11. default operator credential cannot revalidate the secondary project;
12. a default-scoped request cannot smuggle a secondary source key;
13. the correct secondary operator can revalidate the secondary event;
14. secondary Statsig replay is rejected.

After live acceptance, independently verify in ETLayer PostHog EU Project 117513 that:

- the secondary allowed shared event exists with trusted `etlayer.project.id=etlayer-secondary`;
- the default allowed event exists with trusted `etlayer.project.id=etlayer-default`;
- the default authority-blocked copy of the shared event did not create a second destination capture.

## Backward compatibility

Existing VS3-VS7 acceptance helpers now default to:

```text
ETLAYER_PROJECT_ID=etlayer-default
```

and use project-prefixed storage/operator requests.

The generic replay helper also sends the default project scope unless overridden through environment configuration.

## Non-goals

- hosted control plane;
- database-backed project CRUD;
- organization/account hierarchy;
- billing or quotas;
- arbitrary RBAC;
- per-project custom policy language;
- automated migration of pre-VS8 R2 objects;
- per-project destination secret management.

The last item is deliberately deferred. VS8 proves project routing/isolation semantics first. A future management slice can move destination credentials and project registration out of static reference configuration.

## Acceptance status

### VS8.1 - Core project isolation - complete

- project registry implemented;
- trusted provenance v2 implemented;
- project-namespaced canonical and derived state implemented;
- project-scoped routing implemented;
- project-scoped replay implemented;
- project-scoped revalidation implemented;
- project-specific operator credentials implemented;
- destination projections overwrite producer project claims with trusted project identity;
- existing acceptance helpers updated for the default project;
- unit/integration tests cover credential mapping, namespace isolation, routing, replay, revalidation, and projection behavior.

### VS8.2 - Live acceptance - pending

- run `./scripts/once/vs8-project-isolation.sh`;
- record live R2 source keys and event IDs;
- verify PostHog EU Project 117513 provider-side project properties;
- update this document with live evidence;
- close #31 and merge PR #32.

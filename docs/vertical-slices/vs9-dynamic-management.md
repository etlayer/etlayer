# VS9: Dynamic project, producer, and destination management

**Status: VS9 complete; isolated Cloudflare live acceptance and independent PostHog verification passed on 2026-09-23.**

## Goal

Remove source-code edits from ETLayer onboarding.

VS8 proved that project isolation works. VS9 makes project, producer, and destination enablement runtime configuration rather than compile-time configuration.

## Core invariant

```text
management creates project
project operator manages project
producer credential resolves trusted project/profile
plaintext credentials are returned once and never persisted
rotation invalidates the old credential
disabled producer credentials are rejected
destination enablement is project-scoped
```

## Management API

VS9 adds:

```text
POST /_mgmt/projects
POST /_mgmt/projects/:projectId/producers
POST /_mgmt/projects/:projectId/producers/:producerId/rotate
POST /_mgmt/projects/:projectId/producers/:producerId/disable
PUT  /_mgmt/projects/:projectId/destinations/:destination
POST /_mgmt/evidence
```

The API is intentionally small.

There are no list/search endpoints, project deletion, producer re-enable, billing, organization hierarchy, or arbitrary RBAC in this slice.

## Authentication boundaries

Project creation uses:

```text
ETLAYER_MANAGEMENT_KEY
```

Everything inside a dynamic project uses the project's operator credential.

Producer traffic uses the generated producer credential.

Therefore the trust chain becomes:

```text
management credential
  -> creates project

project operator credential
  -> manages that project

producer credential
  -> resolves trusted project + profile
  -> sends events
```

A project operator credential cannot manage a different project.

## Registry storage

VS9 uses the existing R2 archive binding under a reserved control-plane prefix:

```text
registry/projects/<project-id>.json
registry/operators/<sha256-fingerprint>.json
registry/producers/<project-id>/<producer-id>.json
registry/producer-credentials/<sha256-fingerprint>.json
```

Project event/evidence storage remains separate:

```text
projects/<project-id>/...
```

The registry therefore does not weaken the VS8 project evidence namespace.

## Credential storage

Generated credentials look like:

```text
etl_op_<random>
etl_prod_<random>
```

They are returned only by create/rotate responses.

ETLayer persists only:

```text
SHA-256(credential)
```

The plaintext credential is not written to R2.

Dynamic authentication performs an exact fingerprint-key lookup instead of scanning registry objects.

## Producer profiles

VS9 supports the existing canonical profile templates:

```text
browser
backend
agent-runtime
legacy
```

A dynamic producer record resolves:

```text
profileId
producerKind
allowedAuthorityKinds
```

and those values become trusted provenance in exactly the same format introduced by VS8.

## Rotation semantics

A producer record owns the current credential fingerprint:

```text
producer.credentialFingerprint
```

Authentication requires both:

```text
credential record status = active

AND

credential fingerprint =
producer.current credentialFingerprint
```

Rotation writes the new credential record, advances the producer pointer, then marks the previous credential record `superseded`.

The producer pointer is authoritative. Therefore an old credential stops authenticating as soon as the pointer advances even if a later superseded-status write is interrupted.

## Disable semantics

Disabling a producer changes:

```text
producer.status = disabled
```

Authentication always re-reads the producer record. The current credential therefore stops authenticating without deleting historical credential evidence.

Producer re-enable is intentionally out of scope.

## Dynamic destinations

A dynamic project stores an enabled destination set:

```text
destinations:
  - posthog
  - statsig
```

Routing and replay resolve this set from the registry.

The adapter implementation remains known code. VS9 does not allow arbitrary destination names.

### Provider secrets

Per-project provider secret storage is not part of VS9.

The current Cloudflare reference runtime still supplies:

```text
POSTHOG_PROJECT_TOKEN
STATSIG_SERVER_SECRET
```

as Worker secrets.

VS9 answers:

> Which known destination adapters are enabled for this project?

It does not yet answer:

> Which provider credential belongs to this project?

That is intentionally deferred rather than storing sensitive provider credentials in R2.

## Static compatibility

The VS8 reference projects remain supported:

```text
etlayer-default
etlayer-secondary
```

Authentication first checks the existing static Worker-secret profiles.

If no static credential matches, it resolves a dynamic producer through the registry.

Static operator credentials also remain valid for existing project operations.

This lets ETLayer adopt dynamic onboarding without migrating or invalidating the VS8 fixtures.

## Management evidence

```text
POST /_mgmt/evidence
```

is an exact-key diagnostic operation protected by the global management credential.

It:

- accepts only `registry/...` exact keys;
- does not support list/search;
- does not return generated plaintext credentials because registry records never contain them.

The live acceptance uses it to prove that only credential fingerprints were persisted.

## Live acceptance

The isolated Cloudflare workflow runs:

```bash
./scripts/once/vs8-project-isolation.sh
./scripts/once/vs9-dynamic-management.sh
```

serially against the same `ci` environment.

VS9 acceptance:

1. rotates an ephemeral `ETLAYER_MANAGEMENT_KEY`;
2. deploys the current branch to `etlayer-ingest-ci`;
3. creates two unique dynamic projects;
4. proves project B operator cannot mutate project A;
5. enables PostHog for project A;
6. creates a backend producer;
7. reads exact registry evidence and proves plaintext credentials are absent;
8. sends an allowed `account.created` event;
9. proves trusted project/profile authority evidence;
10. proves PostHog delivery exists and Statsig delivery does not;
11. rotates the producer credential;
12. proves the old credential returns HTTP 401;
13. proves the rotated credential succeeds;
14. proves the old credential record becomes `superseded`;
15. disables the producer;
16. proves the current credential returns HTTP 401.

After the automated run, exact accepted event IDs are independently checked in ETLayer PostHog EU Project 117513.

## Non-goals

- UI;
- billing or quotas;
- organizations/accounts;
- arbitrary RBAC;
- project deletion;
- producer re-enable;
- custom producer profiles;
- arbitrary destination adapters;
- per-project destination provider secrets;
- migration of static VS8 projects into the registry.

## Acceptance status

### VS9.1 - Dynamic management core - complete

- registry primitives implemented;
- dynamic project creation implemented;
- operator credential creation implemented;
- producer creation implemented;
- producer credential rotation implemented;
- producer disable implemented;
- destination enable/disable implemented;
- dynamic ingest authentication implemented;
- dynamic operator authentication implemented;
- dynamic routing implemented;
- dynamic replay/revalidation compatibility implemented;
- exact registry evidence operation implemented;
- static VS8 behavior remains compatible;
- unit/integration lifecycle tests pass.

### VS9.2 - Live acceptance - complete

GitHub Actions `Live Acceptance #22` passed on 2026-09-23 and executed VS8 first, then VS9, against the isolated Cloudflare `ci` environment.

VS9 live run:

```text
correlationId:
  vs9-20260923-032221-2e825014

projectId:
  vs9-20260923-032221-2e825014-a

secondProjectId:
  vs9-20260923-032221-2e825014-b

producerId:
  backend-main
```

Accepted events:

```text
initialEventId:
  d03292f5-4a38-4bd2-8402-29ae4d34048e

rotatedEventId:
  9cc566aa-05b7-4677-a2d8-23c63a42419c
```

Canonical source keys:

```text
projects/vs9-20260923-032221-2e825014-a/events/2026/09/23/03/d03292f5-4a38-4bd2-8402-29ae4d34048e.json

projects/vs9-20260923-032221-2e825014-a/events/2026/09/23/03/9cc566aa-05b7-4677-a2d8-23c63a42419c.json
```

The automated live acceptance proved:

```text
dynamicDestinations              = [posthog]
crossProjectOperatorStatus       = 401
oldCredentialStatus              = 401
disabledCredentialStatus         = 401
registryStoresFingerprintsOnly   = true
rotationSupersedesOldCredential  = true
```

It also proved:

- project A and project B were created dynamically at runtime;
- project B's operator could not mutate project A;
- PostHog was enabled without editing source code;
- a backend producer was created dynamically;
- only SHA-256 credential fingerprints were present in exact registry evidence;
- the initial producer credential authenticated and produced trusted `backend/business_state` authority;
- Statsig delivery evidence was absent because only PostHog was enabled;
- rotation immediately invalidated the old producer credential;
- the rotated credential authenticated and produced a second event;
- the previous credential registry record became `superseded`;
- disabling the producer immediately invalidated the current credential.

Independent provider-side SQL verification in ETLayer PostHog EU Project `117513` returned:

```text
d03292f5-4a38-4bd2-8402-29ae4d34048e
  event       = account.created
  project     = vs9-20260923-032221-2e825014-a
  total rows  = 1

9cc566aa-05b7-4677-a2d8-23c63a42419c
  event       = account.created
  project     = vs9-20260923-032221-2e825014-a
  total rows  = 1
```

Both rows carried the trusted dynamic project property:

```text
etlayer.project.id = vs9-20260923-032221-2e825014-a
```

This is end-to-end evidence that a project and producer created entirely through the management API can authenticate, route, rotate credentials, and continue delivering to the configured destination without any source-code configuration change.

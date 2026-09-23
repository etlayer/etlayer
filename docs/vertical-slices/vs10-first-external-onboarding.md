# VS10: First external user onboarding

**Status: implementation complete; CI and isolated live acceptance pending.**

## Goal

Make the first ETLayer integration possible without requiring the integrator to understand ETLayer's internal R2 layout, evidence keys, or hardcoded project configuration.

VS9 made project and producer provisioning dynamic. VS10 turns that capability into a developer-facing onboarding path.

## Core user journey

```text
project exists
  -> operator provisions onboarding bundle
  -> receives producer credential once
  -> gets canonical OTLP endpoint + headers
  -> runs generated first-event quickstart
  -> receives eventId locally
  -> inspects by projectId + eventId
  -> sees decision and delivery state
```

The developer never needs to construct or know keys such as:

```text
projects/<project>/authority/<event>.json
projects/<project>/decision-latest/<event>.json
projects/<project>/deliveries/posthog/<event>.json
```

## Product API

VS10 adds:

```text
POST /_mgmt/projects/:projectId/onboarding
POST /_ops/inspect
```

### POST /_mgmt/projects/:projectId/onboarding

Authentication:

```text
Bearer <project operator credential>
```

Input:

```json
{
  "producerId": "backend-main",
  "destinations": ["posthog"]
}
```

VS10 intentionally provisions the canonical backend profile because the first-event example is the managed `account.created@1` business event.

The onboarding endpoint is restricted to dynamic registry projects. The internal static reference projects (`etlayer-default` and `etlayer-secondary`) continue to use their VS8/VS9 configuration paths and cannot accidentally create partial onboarding registry state.

Other producer profiles remain available through the lower-level VS9 producer API.

The response is one-shot and contains:

```text
projectId
producer metadata
producer credential
enabled destinations

OTLP/HTTP JSON endpoint
required headers

event inspection endpoint
copy-ready Node quickstart
```

The generated producer credential may appear multiple times in this single response (for example in the connection header and generated quickstart), but it is never persisted in plaintext.

## Connection contract

The bundle exposes:

```json
{
  "connection": {
    "protocol": "otlp/http-json",
    "endpoint": "https://.../v1/logs",
    "headers": {
      "authorization": "Bearer <producer-credential>",
      "content-type": "application/json"
    }
  }
}
```

ETLayer remains OTel-native. VS10 does not introduce a proprietary replacement ingest protocol.

## Generated first event

The Node quickstart generates a new UUID locally and sends:

```text
account.created@1
producer kind = backend
authority kind = business_state
```

with the required contract attributes:

```text
actor.anonymous.id
account.id
correlation.id
causation.id
etlayer.producer.kind
etlayer.authority.kind
etlayer.schema.version
etlayer.event.id
```

The quickstart deliberately does **not** send `etlayer.project.id`. Trusted project attribution comes only from the authenticated producer credential and is stamped by ETLayer.

The script prints:

```json
{
  "eventId": "...",
  "projectId": "...",
  "inspect": {
    "endpoint": "https://.../_ops/inspect",
    "body": {
      "projectId": "...",
      "eventId": "..."
    }
  }
}
```

This preserves the standard OTLP success response while still giving the developer an event ID they can use for ETLayer inspection.

## POST /_ops/inspect

Authentication:

```text
Bearer <project operator credential>
```

Input:

```json
{
  "projectId": "customer-a",
  "eventId": "..."
}
```

The endpoint derives all storage keys internally and assembles:

- validation state;
- authority state;
- privacy state;
- identity state;
- latest decision;
- configured destination delivery states;
- canonical source key when known.

No R2 key is supplied by the caller.

## Inspection lifecycle

The response has a stable top-level lifecycle status.

### pending_or_unknown

No durable event evidence exists yet.

This deliberately combines two cases that cannot be distinguished without introducing an event index:

- the event was just accepted and has not reached durable processing yet;
- the event ID does not exist in the project.

This is appropriate for onboarding polling and avoids a misleading 404 during asynchronous Queue processing.

### processing

Some durable state exists, but the latest decision or configured destination delivery state is not complete yet.

### complete

A durable decision exists and either:

- routing was blocked / not eligible; or
- every configured destination has durable delivery state; or
- the project has no configured destinations.

## Delivery view

Each configured destination is represented as:

```text
exported
skipped
failed
pending
not_routed
```

The `state` field includes the underlying durable delivery record when one exists.

If the decision says `routeEligible=false`, a missing destination state is surfaced as `not_routed` rather than `pending`.

## Project isolation

Inspection uses the same project operator boundary introduced in VS8/VS9.

Therefore:

```text
operator B
  + project A eventId
  -> 401
```

The caller cannot use event IDs to cross project boundaries.

## Credential handling

The onboarding producer credential is generated once and returned only in the onboarding response.

R2 stores only its SHA-256 fingerprint through the VS9 registry.

The generated quickstart embeds the credential because it is part of the same one-shot secret response. ETLayer does not store the generated source or credential server-side.

## Live acceptance

The isolated Cloudflare suite now runs:

```bash
./scripts/once/vs8-project-isolation.sh
./scripts/once/vs9-dynamic-management.sh
./scripts/once/vs10-first-external-onboarding.sh
```

VS10 acceptance:

1. rotates an ephemeral management credential;
2. deploys the current Worker to the isolated `ci` environment;
3. creates two unique dynamic projects;
4. provisions project A through the onboarding endpoint;
5. validates returned connection and quickstart metadata;
6. proves an unknown event returns `pending_or_unknown`;
7. writes the generated quickstart source to a temporary `.mjs` file;
8. runs the generated script exactly as delivered;
9. captures the emitted event ID from stdout;
10. polls `/_ops/inspect` by event ID only;
11. waits for `status=complete`;
12. proves contract validation is valid;
13. proves backend/business-state authority is allowed;
14. proves route eligibility is true;
15. proves PostHog delivery is exported;
16. proves only PostHog is configured for the project;
17. proves project B operator cannot inspect project A's event.

After the automated run, the exact event ID is independently queried in ETLayer PostHog EU Project `117513`.

## Non-goals

- public signup/auth;
- dashboard UI;
- billing;
- organizations/accounts;
- transactional multi-resource onboarding rollback;
- arbitrary destination adapters;
- per-project provider secrets;
- event search/listing;
- replacing OTLP with a proprietary ingest endpoint.

## Acceptance status

### VS10.1 - Onboarding product surface - complete

- operator onboarding endpoint implemented;
- one-shot backend producer credential implemented;
- OTLP connection metadata implemented;
- generated first-event Node quickstart implemented;
- event inspection by `projectId + eventId` implemented;
- inspection lifecycle states implemented;
- configured delivery aggregation implemented;
- project isolation tests implemented;
- plaintext producer credential persistence test implemented.

### VS10.2 - Live acceptance - pending

- run final isolated VS8 -> VS9 -> VS10 suite;
- record exact project and event ID;
- independently verify PostHog delivery;
- update this document with live proof;
- close #35 and merge PR #36.

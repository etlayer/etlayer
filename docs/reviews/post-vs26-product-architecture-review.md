# Post-VS26 Product and Architecture Review

Status: current architecture checkpoint after VS26.

Review date: 2026-09-27.

## Executive summary

ETLayer has completed a coherent trust-governance core and now exposes the first useful developer-facing read chain entirely through supported product boundaries.

The supported path is now:

~~~text
project operator
  -> GET /api/v1/projects/:projectId
  -> known contract coordinate
  -> GET /api/v1/projects/:projectId/contracts/:eventName/:version
  -> deterministic TypeScript type + validator
~~~

The accumulated Cloudflare proof passes VS8 -> VS26 serially.

The next product gap is no longer whether ETLayer can expose or generate a typed contract artifact.

It is discovery.

A supported client that does not already know the exact event name and version still has no public way to enumerate the contracts available to a project. A UI, CLI, MCP tool, or external SDK would otherwise need prior knowledge or an internal governance/storage surface.

The strongest next sequencing candidate is therefore a **Supported Contract Catalog / Discovery** read surface.

Do not assign it a vertical-slice number until its issue/design captures the exact invariant and executable acceptance.

## What VS26 changed

VS26 established:

~~~text
authoritative ETLayer contract
  -> supported public Contract artifact
  -> deterministic standalone TypeScript
~~~

The generated output derives from ETLayer's existing contract language.

It does not:

- introduce a second schema language;
- import ETLayer implementation packages;
- expose R2 or internal management coordinates;
- require a proprietary ingest protocol.

The final full regression also re-proved the earlier trust, governance, service-protection, and project-read slices together with the new contract boundary.

## Current supported product boundary

The externally supported read/write surface now includes:

~~~text
POST /api/v1/projects/:projectId/onboarding
GET  /api/v1/projects/:projectId
GET  /api/v1/projects/:projectId/events/:eventId
GET  /api/v1/projects/:projectId/contracts/:eventName/:version

POST /v1/logs
  remains standard OTLP ingest
~~~

This is enough for a client that already knows what project and exact contract it wants.

It is not yet enough for a generic client to discover the project's contract space.

## The remaining discovery gap

Today an external consumer must already possess:

~~~text
eventName
version
~~~

before it can use the VS26 artifact endpoint.

That is acceptable for generated code checked into one application, but it is insufficient for:

- a contract catalog UI;
- a CLI that explores a project;
- an MCP tool used by an agent;
- SDK generation across all project contracts;
- later semantic search;
- later consumer-impact analysis.

Using `/_mgmt`, `/_ops`, R2 listing, or implementation imports to solve discovery would break the product boundary established by VS12, VS25, and VS26.

## Selected sequencing candidate

### Supported Contract Catalog / Discovery

Candidate public boundary:

~~~text
GET /api/v1/projects/:projectId/contracts
Authorization: Bearer <project-operator>
~~~

Target invariant:

~~~text
project operator
  -> supported deterministic contract catalog
  -> exact supported contract artifact links

without:
  prior event/version knowledge
  /_mgmt
  /_ops
  R2 keys
  implementation imports
~~~

The catalog should be a read model over authoritative current contract state, not a second persisted catalog.

## Smallest useful shape

A minimal item should identify:

~~~text
eventName
version
source        project | builtin
lifecycle     Published | Deprecated | Retired | null
links.self    exact VS26 contract artifact
~~~

Ordering must be deterministic.

For an exact event/version coordinate where a project-published contract exists, project resolution remains authoritative over the built-in fallback, matching VS26 semantics.

Do not add search, pagination, ownership joins, dependency analysis, or generated source blobs unless acceptance proves they are necessary for the first useful catalog.

## Executable acceptance candidate

A future numbered slice should prove at least:

1. create an isolated dynamic project;
2. publish `account.created@2`;
3. deprecate the project version;
4. read the supported contract catalog;
5. prove built-in `account.created@1` is discoverable;
6. prove project `account.created@2` is discoverable with its lifecycle;
7. prove deterministic ordering and byte-stable repeated reads for unchanged state;
8. follow each returned exact artifact link and prove it resolves through the VS26 endpoint;
9. prove no internal URLs, storage keys, credentials, or secret fields are exposed;
10. prove another project operator receives 401;
11. preserve the accumulated VS8 -> current-slice regression.

## Why not OpenAPI next

OpenAPI would describe HTTP operations.

It would not solve discovery of project-specific business-event contracts by itself.

Once the supported API and catalog are broad enough, OpenAPI can be generated or maintained as a thin description of that stable boundary.

## Why not a packaged SDK next

VS26 deliberately proved deterministic generation before package distribution.

Publishing an npm SDK now would add packaging/versioning/release concerns while the generic discovery workflow is still incomplete.

A later SDK should consume:

~~~text
project read
  + contract catalog
  + exact contract artifacts
~~~

rather than embed an independent contract inventory.

## Why not UI or MCP next

Both are now increasingly viable, but both would immediately need supported discovery.

Building the catalog first keeps:

~~~text
UI
CLI
MCP
SDK
  -> supported product APIs
~~~

instead of giving any of them privileged storage knowledge.

## Workspace / Environment remains deferred

The post-VS23 finding still holds.

ETLayer still has no higher-level Workspace/Environment identity proving that multiple projects belong to one promotion domain.

Do not add a fake environment label or weaken `manifestDigest` identity merely to unlock promotion.

Environment Promotion should return after Workspace/Environment identity is concrete.

## Production-hardening note

VS24 established request-rate and payload/event-count protection, but hosted-product work still needs broader controls over time:

- quotas and resource limits;
- credential lifecycle;
- retention;
- queue/backlog operating limits;
- DLQ operations;
- SLOs;
- backup/recovery;
- deployment/rollback;
- customer-visible failure semantics.

Those remain separate from the immediate contract-discovery gap.

## Checkpoint decision

VS26 is complete and live-proven.

The next sequencing candidate is:

~~~text
Supported Contract Catalog / Discovery
~~~

Keep it unnumbered until the roadmap rule is satisfied:

~~~text
concrete risk
+ target invariant
+ executable acceptance
+ smallest useful scope
= next vertical slice
~~~

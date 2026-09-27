# Post-VS27 Product and Architecture Review

Status: current architecture checkpoint after VS27.

Review date: 2026-09-27.

## Executive summary

ETLayer now has a coherent supported developer read chain:

~~~text
project
  -> supported project read
  -> supported contract catalog
  -> supported exact contract artifact
  -> deterministic standalone TypeScript generation
~~~

VS27 closes the discovery gap that existed after VS26. A client no longer needs prior event/version knowledge or internal storage/management access to enumerate the effective contract space.

The next useful gap is now end-to-end developer automation rather than another server-side contract representation.

The strongest sequencing candidate is **Project Contract Pull + TypeScript Generation**: a thin external client that traverses the supported public API and deterministically generates the complete project contract TypeScript output.

Keep it unnumbered until its exact issue/design and executable acceptance are created.

## What VS27 changed

Before VS27:

~~~text
known eventName + version
  -> exact contract artifact
  -> TypeScript
~~~

After VS27:

~~~text
known project
  -> contract catalog
  -> all effective exact coordinates
  -> exact artifacts
  -> TypeScript
~~~

This matters because generic UI, CLI, SDK, and agent clients can now remain entirely on supported product boundaries.

## Current supported product boundary

~~~text
POST /api/v1/projects/:projectId/onboarding
GET  /api/v1/projects/:projectId
GET  /api/v1/projects/:projectId/events/:eventId
GET  /api/v1/projects/:projectId/contracts
GET  /api/v1/projects/:projectId/contracts/:eventName/:version

POST /v1/logs
  remains standard OTLP ingest
~~~

The catalog and exact artifact endpoints are read-only and project-operator authenticated.

## Remaining DX friction

The repository currently has:

~~~text
npm run contract:generate --
  --file <one-contract-artifact.json>
  --out <one-generated-module.ts>
~~~

That proves deterministic generation for one already-downloaded artifact.

A real project consumer must still manually:

1. call the catalog;
2. iterate contract coordinates;
3. fetch each exact artifact;
4. invoke generation repeatedly;
5. define deterministic file/index layout;
6. handle authentication without leaking credentials.

That is now integration boilerplate, not missing server semantics.

## Selected sequencing candidate

### Project Contract Pull + TypeScript Generation

Candidate developer workflow:

~~~text
ETLAYER_OPERATOR_CREDENTIAL=<secret>

npm run contract:generate:project --
  --base-url https://events.example.com
  --project-id customer-a
  --out-dir ./generated/etlayer
~~~

Target invariant:

~~~text
base URL
+ project ID
+ project operator credential
  -> supported contract catalog
  -> supported exact artifacts
  -> deterministic project TypeScript output

without:
  /_mgmt
  /_ops
  R2 access
  Wrangler/Cloudflare credentials
  ETLayer runtime implementation imports
  hand-maintained contract inventory
~~~

The operator credential should come from environment input rather than a command-line flag so normal process listings do not expose it.

## Smallest useful output

The first slice should avoid package publication.

A deterministic output directory is sufficient:

~~~text
generated/etlayer/
  account-created-v1.ts
  account-created-v2.ts
  ...
  index.ts
~~~

The exact file naming algorithm and index ordering must be deterministic and collision-safe.

Each generated contract module should continue to use the VS26 standalone generator semantics.

## Executable acceptance candidate

A future numbered slice should prove:

1. create one isolated live project;
2. publish and deprecate a project contract;
3. invoke the project generator from a clean external-consumer context;
4. fetch discovery only through the VS27 public catalog;
5. fetch contract bodies only through VS26 exact artifact links;
6. generate all effective project contract modules;
7. generate byte-identical output on a second run;
8. compile or execute representative generated validators;
9. prove generated code has no ETLayer implementation imports;
10. prove the client has no `/_mgmt`, `/_ops`, R2, Wrangler, or Cloudflare dependency;
11. prove an incorrect project credential fails without partial output;
12. preserve accumulated regression.

## Why not package an SDK yet

Package publication introduces release/versioning/distribution concerns that are not needed to prove the developer workflow.

First prove that a clean external client can pull and generate a complete project contract set through supported APIs. Packaging can wrap that proven behavior later.

## Why not OpenAPI next

OpenAPI is now more justified than it was before VS27 because the supported public surface is broader and more coherent.

However, a handwritten or separately maintained OpenAPI document risks becoming another source of truth. Generating or validating it cleanly will likely require a deliberate route/schema description model.

The project-generation workflow has a smaller immediate boundary because it can consume the APIs exactly as they exist today without changing server semantics.

OpenAPI remains a strong later DX/API candidate.

## Why not MCP next

VS27 makes a read-only MCP contract discovery tool technically straightforward.

But an MCP layer would currently be another protocol client over capabilities that can first be proven through the ordinary public API. Keeping the next slice protocol-neutral preserves reuse for CLI, SDK, CI, and MCP later.

## Workspace / Environment remains deferred

The post-VS23 promotion finding is unchanged.

Environment Promotion still needs a real higher-level Workspace/Environment identity before cross-project promotion can be a product boundary rather than a label.

## Checkpoint decision

VS27 is complete and live-proven.

The next sequencing candidate is:

~~~text
Project Contract Pull + TypeScript Generation
~~~

Do not assign a new VS number until the roadmap rule is satisfied:

~~~text
concrete risk
+ target invariant
+ executable acceptance
+ smallest useful scope
= next vertical slice
~~~

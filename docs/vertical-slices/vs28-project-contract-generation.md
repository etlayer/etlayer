# VS28: Project Contract Pull + TypeScript Generation

**Status: implementation in progress.**

Tracks issue #104.

## Goal

Turn the VS26 + VS27 public contract surface into one deterministic project-wide developer workflow.

A developer should be able to provide only:

```text
base URL
project ID
project operator credential
```

and receive a complete deterministic TypeScript representation of the project's effective contracts.

## Core invariant

```text
base URL
+ project ID
+ project operator credential
  -> GET supported VS27 contract catalog
  -> GET supported VS26 exact artifacts
  -> deterministic project TypeScript output

without:
  /_mgmt
  /_ops
  storage coordinates
  Wrangler/Cloudflare credentials
  cloudflare-ingest runtime implementation imports
  hand-maintained contract inventory
```

## Command boundary

```bash
ETLAYER_OPERATOR_CREDENTIAL=... \
npm run contract:generate:project -- \
  --base-url https://events.example.com \
  --project-id customer-a \
  --out-dir ./generated/etlayer
```

The operator credential is intentionally environment-only. It is not accepted as a CLI argument.

## Public traversal only

The generator may call only:

```text
GET /api/v1/projects/:projectId/contracts
GET /api/v1/projects/:projectId/contracts/:eventName/:version
```

It must not call internal ETLayer surfaces or inspect storage.

The catalog is discovery only. Exact contract bodies remain authoritative through VS26 artifacts.

## Generator boundary extraction

VS26's deterministic TypeScript generator currently lives under:

```text
packages/cloudflare-ingest/src/typescript-contract-generator.js
```

That location makes a DX client depend on a runtime implementation package.

VS28 extracts the pure contract normalization and TypeScript generation semantics into:

```text
packages/contract-tools/
```

The Cloudflare package may preserve compatibility through thin re-exports/wrappers, but project tooling must depend on the pure contract-tools boundary rather than the Worker implementation package.

This is a boundary cleanup, not a new generator implementation.

## Artifact-link trust

The catalog returns exact artifact links.

Before sending `Authorization` to an artifact URL, the client must prove:

1. the URL uses the same origin as `--base-url`;
2. the URL has no unexpected query or fragment;
3. the path is exactly the expected public project-contract coordinate for the catalog item.

A malformed or cross-origin link fails before any credential-bearing request is made.

## Deterministic output

The client canonicalizes catalog coordinates by:

```text
eventName ascending
then version ascending
```

Duplicate exact coordinates are invalid.

Each exact coordinate produces one standalone TypeScript module.

Filename mapping must be deterministic and collision-safe for arbitrary valid event names. The implementation may combine a readable slug with a reversible encoded event-name component.

The generated `index.ts` must also be deterministic and must avoid export-name collisions between event names that normalize to the same TypeScript words.

## Atomic publication

Generation is all-or-nothing.

The client:

1. fetches and validates the complete catalog;
2. fetches and validates every exact artifact;
3. generates every module and the index in a staging directory;
4. publishes the staged directory only after all work succeeds.

If authentication, link validation, artifact validation, network access, or generation fails, the requested output directory is not partially replaced.

## Acceptance

### Unit/integration

Prove:

- deterministic catalog canonicalization;
- duplicate-coordinate rejection;
- same-origin exact-path artifact validation;
- cross-origin artifact rejection before credential forwarding;
- deterministic collision-safe filenames;
- deterministic collision-safe index exports;
- byte-identical repeated generation;
- invalid authentication does not publish partial output;
- existing output remains intact when a later generation fails;
- generated modules contain no runtime imports;
- representative generated validators execute.

### Live

1. deploy current branch to isolated Cloudflare CI;
2. create an isolated project;
3. publish a project contract and move one version to Deprecated;
4. invoke the project generator using only public base URL, project ID, and operator credential;
5. discover through the VS27 catalog only;
6. fetch contract bodies through VS26 exact artifact links only;
7. prove built-in and project-published versions are present;
8. prove lifecycle does not change generated contract semantics;
9. run generation twice and compare the complete output tree byte-for-byte;
10. execute representative generated validators;
11. run the same command with an invalid credential and prove no partial output is published;
12. run the static external-boundary check;
13. preserve the accumulated VS8 -> VS28 regression.

## Non-goals

- npm package publication;
- SDK release/version policy;
- OpenAPI generation;
- MCP;
- dashboard UI;
- Workspace/Environment identity;
- contract search;
- language targets other than TypeScript;
- automatic file watching;
- schema migration tooling.

## Why this slice now

VS25 made project state readable through the supported product API.

VS26 made exact contracts readable and generatable.

VS27 made the effective project contract set discoverable.

The remaining DX friction is manual traversal and per-contract generation. Removing that friction now proves the complete protocol-neutral public workflow before ETLayer commits to package distribution, SDKs, or MCP adapters.

# Post-VS28 Product and Architecture Review

Status: current architecture checkpoint after VS28.

Review date: 2026-09-27.

## Executive summary

ETLayer now has a complete supported contract-consumption chain from a project identity to deterministic generated TypeScript:

~~~text
project
  -> supported project read
  -> supported contract catalog
  -> supported exact contract artifacts
  -> deterministic project-wide TypeScript generation
~~~

VS28 closes the manual traversal gap that remained after VS27. A consumer can now provide only the public ETLayer base URL, project ID, and project operator credential and produce a complete byte-stable generated contract tree without using internal management/operations surfaces, storage coordinates, Wrangler, Cloudflare credentials, or the Cloudflare runtime implementation package.

The strongest remaining DX gap is no longer protocol traversal. It is **distribution**.

The current project generator is proven, but it still runs from an ETLayer source checkout. The next sequencing candidate is therefore an **Installable Contract Tooling Package Boundary**: package the already-proven contract tooling so a clean consumer can install and invoke it without cloning ETLayer.

Keep the candidate unnumbered until its issue defines exact package/binary semantics and executable acceptance.

## What VS28 changed

Before VS28:

~~~text
project
  -> catalog
  -> manually iterate coordinates
  -> manually fetch artifacts
  -> invoke single-contract generation repeatedly
  -> manually assemble files/index
~~~

After VS28:

~~~text
ETLAYER_OPERATOR_CREDENTIAL=...

npm run contract:generate:project --
  --base-url https://events.example.com
  --project-id customer-a
  --out-dir ./generated/etlayer
~~~

The command:

- discovers only through the supported VS27 catalog;
- fetches only supported VS26 exact artifact links;
- rejects cross-origin or unexpected artifact links before forwarding Authorization;
- canonicalizes the project contract set;
- emits deterministic collision-safe module names and index namespaces;
- publishes output only after the complete generation succeeds;
- preserves prior output on authentication/fetch/generation failure.

## Contract-tool boundary

VS28 also removes an implementation leak that existed in VS26.

The pure normalization and TypeScript generation code now lives under:

~~~text
packages/contract-tools/
~~~

The Cloudflare runtime retains compatibility through a thin adapter/re-export, while developer tooling no longer imports:

~~~text
packages/cloudflare-ingest
~~~

This makes the next package/distribution step materially cleaner.

## Live proof

Implementation PR #105 was proven before merge by:

~~~text
CI                    #36331032078  success
Fast Live Acceptance  #36331033963  success
~~~

The fast live proof generated seven effective project contract modules and proved:

~~~text
built-in v1 generated             true
project-published v2 generated    true
project v2 lifecycle              deprecated
byte-stable repeated generation   true
generated validator executes      true
invalid auth publishes no partial output
credential leak                   false
external boundary                 true
~~~

Implementation merged to main as:

~~~text
73a7c3a620cab643dd54c28724b7c4fda911611a
~~~

Post-merge proof:

~~~text
main CI               #36331112753  success
full Live Acceptance  #36331112735  success
suite                  VS8 -> VS28
~~~

The final full live VS28 project used:

~~~text
projectId:
  vs28-20260927-161300-b792856f

manifestDigest:
  cc6c9abdeea099a30d6cfa755a859518c61462f7daa14e94b2318f99c8bbcfb4

generated contract modules:
  7
~~~

The accumulated run ended with:

~~~text
Full live regression passed: VS8 -> VS28
~~~

## Remaining developer friction

The workflow is now correct, but using it currently assumes an ETLayer repository checkout because the executable entry point is a root package script.

A real consumer should eventually be able to do something structurally like:

~~~text
install ETLayer contract tooling

ETLAYER_OPERATOR_CREDENTIAL=...
<tool> contracts pull
  --base-url ...
  --project-id ...
  --out-dir ...
~~~

without obtaining ETLayer runtime source.

That is a distribution/package-boundary problem, not a server API problem.

## Selected sequencing candidate

### Installable Contract Tooling Package Boundary

Target invariant:

~~~text
clean Node consumer
+ installable ETLayer contract-tool artifact
+ base URL
+ project ID
+ project operator credential
  -> same deterministic VS28 project output

without:
  ETLayer source checkout
  repository-relative imports
  cloudflare-ingest dependency
  Wrangler/Cloudflare credentials
  duplicated contract-generation semantics
~~~

The exact npm package name and final CLI spelling are intentionally not selected in this review.

## Smallest executable proof

A future numbered slice should first prove the package boundary without requiring a public npm release.

Candidate acceptance:

1. build/pack the contract tooling as an installable npm artifact;
2. install that artifact into a clean temporary consumer with no ETLayer repository imports;
3. expose a package binary or documented package entry point for project contract pull/generation;
4. run it against an isolated live ETLayer project using only base URL, project ID, and operator credential;
5. prove the generated tree is byte-identical to the VS28 repository command;
6. prove package contents contain no Cloudflare runtime source/dependency;
7. prove invalid auth preserves existing output;
8. prove the installed consumer has no repository-relative dependency;
9. preserve accumulated runtime regression.

Only after this package boundary is proven does public registry publication/versioning become a separate operational decision.

## Why not OpenAPI next

OpenAPI remains useful now that the supported API surface is substantial.

However, ETLayer still needs a deliberate answer for how HTTP route descriptions and schemas become a single source of truth rather than a handwritten parallel specification.

VS28 does not create that description model.

Packaging the already-proven contract tooling is a smaller next risk because it changes distribution, not server semantics.

## Why not MCP next

MCP can now consume project/contract public APIs cleanly.

But a reusable installable client/tooling boundary is useful to CLI, CI, SDK, and MCP alike. Proving distribution first avoids implementing MCP-specific traversal or generation logic that would later need to move into a shared package.

## Why not dashboard next

A hosted dashboard would quickly pull in account/workspace identity, membership, sessions, RBAC, and UI-specific API composition.

Those are Phase 3 product concerns. VS28 does not create a reason to introduce them early.

## Workspace / Environment remains deferred

The post-VS23 finding remains unchanged.

Real environment promotion still needs higher-level Workspace/Environment identity and authorization semantics before it can become a trustworthy cross-project product boundary.

## Checkpoint decision

VS28 is complete and live-proven.

The next sequencing candidate is:

~~~text
Installable Contract Tooling Package Boundary
~~~

Do not assign VS29 until the roadmap rule is satisfied:

~~~text
concrete risk
+ target invariant
+ executable acceptance
+ smallest useful scope
= next vertical slice
~~~

# VS16: Contract Compatibility Checker

**Status: complete and CI-proven.**

Tracks GitHub issue #52.

Classification:

~~~text
A2-NOW-GOV/DX
Core - medium effort - do now
Governance + Developer Experience
~~~

## Risk

ETLayer contracts are versioned, but version numbers alone do not tell a developer whether a proposed contract changes the set of accepted events.

Without a deterministic compatibility gate, a seemingly small contract change can move already-valid production events into quarantine after deployment.

## Target invariant

A proposed contract cannot be called compatible without a deterministic comparison against the currently accepted event set.

Compatibility is defined set-theoretically:

~~~text
backward:
  accepted(current) subset-of accepted(proposed)

forward:
  accepted(proposed) subset-of accepted(current)

full:
  backward AND forward
~~~

## Current contract language

VS16 deliberately implements only the contract language ETLayer actually enforces today:

- required attributes;
- primitive type constraints;
- const constraints;
- forbidden attributes.

It does not introduce JSON Schema, Avro, Protobuf, or a generic schema registry.

## Compatibility semantics

Examples:

~~~text
remove required attribute
  backward: compatible
  forward:  breaking

add required attribute
  backward: breaking
  forward:  compatible

add forbidden attribute
  backward: breaking
  forward:  compatible

integer -> number
  backward: compatible
  forward:  breaking

number -> integer
  backward: breaking
  forward:  compatible

add/change const
  narrows accepted values
  backward: breaking
~~~

The engine evaluates constraints as accepted value sets rather than as string diffs.

A stable const can therefore remain compatible even when redundant type detail is removed.

## Machine-readable result

The engine returns:

~~~json
{
  "version": 1,
  "eventName": "account.created",
  "fromVersion": 1,
  "toVersion": 2,
  "mode": "backward",
  "compatible": false,
  "classification": "breaking",
  "backward": {
    "compatible": false,
    "violations": []
  },
  "forward": {
    "compatible": true,
    "violations": []
  },
  "changes": []
}
~~~

Violation codes include:

- required_attribute_added;
- required_attribute_removed;
- attribute_newly_forbidden;
- attribute_no_longer_forbidden;
- attribute_constraint_narrowed;
- attribute_constraint_relaxed.

## CLI

Run:

~~~bash
npm run contract:check -- \
  --from packages/cloudflare-ingest/contracts/account.created.v1.js \
  --to path/to/account.created.v2.js \
  --mode backward \
  --json
~~~

Exit codes:

~~~text
0 compatible
1 invalid input / execution error
2 breaking compatibility
~~~

This makes the checker directly usable in CI before contract publishing exists.

## Executable acceptance

The VS16 acceptance uses the real account.created@1 contract and two non-runtime fixtures.

### Backward-compatible relaxation

The proposed v2 removes causation.id from required.

Expected:

~~~text
backward -> compatible / exit 0
forward  -> breaking
full     -> breaking / exit 2
~~~

### Backward-breaking change

The proposed v2:

- adds required plan.id;
- changes account.id from string to integer.

Expected:

~~~text
backward -> breaking / exit 2

violations:
  required_attribute_added: plan.id
  attribute_constraint_narrowed: account.id
~~~

## Why no Cloudflare live acceptance

VS16 is deterministic governance logic and does not alter Worker runtime behavior, R2 storage, queues, credentials, or destination delivery.

Its authoritative acceptance therefore runs in normal repository CI.

Deploying it to Cloudflare would not add evidence.

The existing serial Cloudflare suite remains responsible for VS8 -> VS15 runtime regressions.

## Non-goals

VS16 does not include:

- dynamic contract persistence;
- contract draft/review/publish lifecycle;
- environment promotion;
- contract registry API;
- historical-event simulation;
- consumer impact graph;
- JSON Schema compatibility;
- automatic contract inference.

Those build on this compatibility primitive.


---

# Completion evidence

VS16 completed with:

~~~text
CI #775                green
acceptance             scripts/once/vs16-contract-compatibility.sh
authoritative surface  deterministic CLI / CI
runtime deployment     not required
~~~

The acceptance proved:

~~~text
account.created@1
  -> relaxed v2

backward
  compatible
  exit 0

forward
  breaking

full
  breaking
  exit 2

account.created@1
  -> breaking v2

required plan.id
  required_attribute_added

account.id
  string -> integer
  attribute_constraint_narrowed

backward
  breaking
  exit 2
~~~

This establishes a machine-enforceable contract-evolution gate without introducing a schema registry or changing runtime event processing.

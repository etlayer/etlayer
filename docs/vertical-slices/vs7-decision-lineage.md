# VS7: Append-only decision history and policy lineage

**Status: code complete and CI green; live Cloudflare acceptance pending.**

## Goal

Preserve every ETLayer policy evaluation for a canonical event instead of keeping only mutable latest-state snapshots.

VS7 makes this distinction explicit:

```text
canonical event          immutable evidence
trusted provenance       immutable evidence
decision history         append-only evidence
latest decision pointer  mutable convenience
latest policy states     mutable convenience
```

## Problem

Before VS7, ETLayer persisted latest state under:

```text
validation/<event-id>.json
authority/<event-id>.json
privacy/<event-id>.json
identity/<event-id>.json
```

Revalidation intentionally evaluates a preserved canonical event under current policy. That means latest state can legitimately change.

Without append-only decision evidence, a future policy change could make it difficult to answer:

> What exact validation, authority, and privacy policy produced the original routing decision?

## Durable decision evidence

Each processing attempt now records:

```text
decisions/<event-id>/<decision-id>.json
```

A convenience pointer is also maintained at:

```text
decision-latest/<event-id>.json
```

The pointer may advance. Historical decision records must not change.

## Decision record

A decision record contains:

```json
{
  "version": 1,
  "decisionId": "...",
  "eventId": "...",
  "eventName": "account.created",
  "evaluationKind": "processing",
  "sourceKey": "events/...",
  "evaluatedAt": "...",
  "provenance": {
    "version": 1,
    "profileId": "browser",
    "producerKind": "browser"
  },
  "validation": {
    "status": "valid",
    "validatorVersion": 1,
    "schemaVersion": 1,
    "contractId": "account.created@1",
    "errors": []
  },
  "authority": {
    "status": "blocked",
    "policyVersion": 1,
    "profileId": "browser",
    "trustedProducerKind": "browser",
    "claim": {
      "producerKind": "backend",
      "authorityKind": "business_state"
    },
    "errors": []
  },
  "privacy": {
    "status": "clean",
    "policyVersion": 1,
    "ingestActions": [],
    "deliveryActions": []
  },
  "routeEligible": false
}
```

Decision evidence contains policy/action metadata, never removed sensitive values or credential material.

## Versioned policy lineage

VS7 makes three policy versions explicit:

```text
contract validator version
authority policy version
privacy policy version
```

Current reference versions are all `1`.

The event schema version and contract ID remain distinct from the validator implementation version:

```text
validatorVersion = implementation semantics
schemaVersion    = producer event schema
contractId       = selected executable contract
```

Similarly:

```text
authority.policyVersion = ETLayer authority evaluation semantics
provenance.version      = trusted provenance envelope format
```

These concepts must not be collapsed.

## Processing order

VS7 records decision evidence before destination routing:

```text
canonical event
  |
contract validation
  |
authority evaluation
  |
delivery privacy
  |
identity resolution
  |
latest state snapshots
  |
append-only decision record
  |
latest decision pointer
  |
route only when eligible
```

This preserves the invariant:

> ETLayer must not route an event unless durable decision evidence for that evaluation already exists.

## Revalidation

Revalidation uses the same preserved canonical event and original trusted provenance, but creates a new decision:

```text
decision A
  evaluationKind = processing

canonical event
      |
      v
revalidation under current policy
      |
      v
decision B
  evaluationKind = revalidation
```

Decision B advances `decision-latest/<event-id>.json`.

Decision A remains unchanged.

Revalidation never means re-executing the original application or agent side effect.

## Live acceptance

Run after deploying the current branch and fixture:

```bash
./scripts/once/deploy-fixture.sh
./scripts/once/vs7-decision-lineage.sh
```

The helper intentionally emits a contract-valid browser credential spoof that VS6 authority policy blocks.

It then proves:

1. initial processing creates an append-only decision record;
2. the decision records validator/authority/privacy versions;
3. the event is contract-valid but authority-blocked;
4. PostHog and Statsig delivery state remains absent;
5. revalidation creates a distinct second decision record;
6. the latest pointer advances to the revalidation decision;
7. the original decision record still exists;
8. the original record is byte-for-byte unchanged;
9. both decisions reference the same canonical source event;
10. revalidation remains blocked with no deliveries.

## Non-goals

- event-sourcing every internal ETLayer state transition;
- arbitrary policy language;
- policy rollback;
- re-executing producer or agent side effects;
- storing removed secret/direct-identifier values in decision evidence;
- replacing latest-state convenience objects;
- making historical decisions mutable when policy changes.

## Acceptance status

### VS7.1 - Decision history core - complete

- append-only decision storage implemented;
- latest decision pointer implemented;
- contract validator version is explicit;
- authority policy version is explicit;
- privacy policy version is preserved;
- processing records decision evidence before routing;
- revalidation is tagged separately;
- unit and integration tests cover append-only history;
- PR CI is green.

### VS7.2 - Live acceptance - pending

- deploy current Worker + fixture;
- run `./scripts/once/vs7-decision-lineage.sh`;
- record live R2 decision keys and IDs;
- independently verify blocked event absence in ETLayer PostHog EU Project 117513;
- close #29 and merge PR #30.

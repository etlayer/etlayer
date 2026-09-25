# VS19: Governance-as-Code Manifest and Deterministic Plan

**Status: implementation in progress.**

Tracks GitHub issue #69.

Classification:

~~~text
A2-NOW-GOV/DX
Core - medium effort - do now
Governance + Developer Experience
~~~

## Risk

VS16 gives ETLayer a deterministic contract compatibility engine.

VS17 gives ETLayer a read-only historical impact plan.

Before VS19, however, the proposed governance input is still supplied as an ad-hoc command or request payload. The artifact reviewed in Git is not itself given a stable runtime identity.

That creates room for drift between:

- reviewed configuration;
- compatibility settings;
- proposed contract contents;
- historical planning window;
- the request actually evaluated by ETLayer.

## Target invariant

~~~text
declarative governance manifest
  -> deterministic normalization
  -> stable SHA-256 digest
  -> static compatibility
  -> historical impact plan

same governance semantics
  -> same normalized manifest
  -> same manifest digest

planning
  -> read-only
  -> no contract publication
  -> no decision mutation
  -> no delivery
~~~

## ProjectGovernance/v1

VS19 introduces one declarative JSON manifest kind:

~~~json
{
  "apiVersion": "etlayer.dev/v1",
  "kind": "ProjectGovernance",
  "projectId": "customer-a",
  "contracts": [
    {
      "eventName": "account.created",
      "currentVersion": 1,
      "compatibilityMode": "backward",
      "proposedContract": {
        "id": "account.created@2",
        "eventName": "account.created",
        "version": 2,
        "required": {},
        "forbidden": []
      },
      "from": "2026-09-25T10:00:00Z",
      "to": "2026-09-25T11:00:00Z",
      "maxEvents": 500,
      "maxExamples": 25
    }
  ]
}
~~~

V1 is deliberately limited to project-scoped contract governance.

It does not attempt to represent all future ETLayer policy domains.

## Deterministic normalization

Normalization makes semantically irrelevant representation differences disappear before hashing.

Examples:

- object key order is canonical;
- contract changes are sorted by event name/current version;
- forbidden attributes are treated as a set and sorted;
- timestamps are normalized to ISO form;
- compatibility/default bounds are explicit in the normalized form.

The normalized document receives:

~~~text
SHA-256(canonical normalized JSON)
  -> manifestDigest
~~~

The digest identifies exactly what governance proposal was planned.

It is not a signature and does not claim author identity.

## Static check

Local/CI usage:

~~~bash
npm run governance:check --   --file path/to/governance.json
~~~

Optional JSON output:

~~~bash
npm run governance:check --   --file path/to/governance.json   --json
~~~

Exit codes:

~~~text
0  all declared contract changes are compatible
1  invalid manifest or execution error
2  one or more contract changes are breaking
~~~

The local check uses the same VS16 compatibility primitive used by runtime planning.

## Historical governance plan

Operator API:

~~~text
POST /_ops/plan/governance
Authorization: Bearer <project-operator>
Content-Type: application/json
~~~

The response includes:

- manifestDigest;
- projectId;
- aggregate selected/changed counts;
- aggregate compatibility status;
- one VS17-compatible plan result per contract change;
- transition counts;
- bounded changed-event examples.

The API is project-scoped through the existing project operator credential.

## Read-only semantics

Governance planning may read:

- built-in current contract definitions;
- canonical preserved project events.

It must not write:

- canonical events;
- validation state;
- authority state;
- privacy state;
- identity state;
- decision history;
- delivery summaries;
- delivery attempts;
- project registry configuration.

VS19 therefore remains a planning capability rather than a publication capability.

## Relationship to VS16 and VS17

~~~text
VS16
contract A -> contract B
static compatibility

VS17
contract A -> contract B
+ historical events
impact plan

VS19
reviewable governance manifest
+ stable manifest identity
+ one-or-more contract changes
+ VS16/VS17 composition
~~~

VS19 does not replace VS16 or VS17.

It packages their semantics into a deterministic, reviewable governance artifact.

## Executable acceptance

The Cloudflare acceptance:

1. creates an isolated dynamic project with no destinations;
2. creates a backend producer;
3. emits two account.created@1 events;
4. proves both are currently ALLOW;
5. records the affected event decision ID;
6. submits a ProjectGovernance/v1 manifest proposing account.created@2;
7. proves the proposal is backward-breaking because plan.id becomes required;
8. proves one event remains ALLOW and one would become QUARANTINE;
9. submits the same semantics with different JSON key/forbidden ordering;
10. proves the exact same manifestDigest and plan result;
11. inspects the affected event after both plans;
12. proves decisionId is unchanged;
13. proves no delivery or attempt was created by planning;
14. keeps VS8 -> VS18 regressions green.

## Non-goals

VS19 does not include:

- governance publication/apply;
- runtime dynamic contract lookup;
- contract draft/review state;
- environment promotion;
- privacy policy manifests;
- authority policy manifests;
- arbitrary policy language;
- signed manifests;
- Git commit attestation;
- GitHub App automation;
- dashboard/UI.

The next useful capability after VS19 can use manifestDigest as the exact proposal identity for guarded publication rather than inventing another representation.

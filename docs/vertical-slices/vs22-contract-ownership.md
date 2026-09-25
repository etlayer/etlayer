# VS22: First-class Contract Ownership Metadata

**Status: implementation in progress.**

Tracks GitHub issue #78.

Classification:

~~~text
A1-NOW-GOV/PRDT
Core - small effort - do now
Governance + Product
~~~

## Risk

ETLayer can publish and lifecycle-manage project-scoped contract versions, but operators still need a direct answer to:

~~~text
who owns this event contract?
~~~

Ownership should exist before catalogs, incidents, violation routing, and governance metrics depend on it.

## Target invariant

~~~text
project + eventName
  -> one current ownership resource

ownership
  -> team
  -> optional domain
  -> bounded operational contacts

ownership write
  -> project-operator authenticated
  -> control-plane audited
  -> normalized
  -> idempotent for identical semantics

event inspection
  -> current ownership visible
~~~

Ownership metadata is not authorization and does not create an organization, directory, or RBAC model.

## Resource

Current ownership lives at:

~~~text
registry/governance/<project>/ownership/<eventName>.json
~~~

Resource v1:

~~~json
{
  "version": 1,
  "projectId": "customer-a",
  "eventName": "account.created",
  "team": "accounts-platform",
  "domain": "accounts",
  "contacts": [
    {
      "kind": "email",
      "value": "accounts@example.com"
    },
    {
      "kind": "slack",
      "value": "#accounts-alerts"
    }
  ],
  "updatedAt": "2026-09-25T21:00:00.000Z"
}
~~~

Ownership is event-semantic scoped rather than contract-version scoped.

That allows a team change without publishing a new schema version.

## Normalization

V1 normalizes:

- team and domain as lowercase slugs;
- event name as a bounded semantic identifier;
- email values to lowercase;
- URL values through URL normalization;
- contact whitespace;
- duplicates;
- contact ordering.

Supported contact kinds:

~~~text
email
slack
url
~~~

Maximum unique normalized contacts:

~~~text
10
~~~

This makes semantically equivalent writes idempotent.

## Management API

~~~text
PUT /_mgmt/projects/:projectId/contracts/:eventName/ownership
GET /_mgmt/projects/:projectId/contracts/:eventName/ownership
~~~

Both routes require the project operator credential.

PUT response:

~~~json
{
  "changed": true,
  "ownership": {}
}
~~~

Submitting the same normalized ownership returns:

~~~text
changed = false
~~~

GET returns the current resource or 404.

## Audit semantics

PUT uses the existing VS15 control-plane audit boundary.

Audit action:

~~~text
contract.ownership.configure
~~~

Audit target:

~~~text
kind = contract_ownership
projectId
eventName
~~~

The audit change records operationally useful shape:

~~~text
team
domain
contactCount
contactKinds
~~~

Raw contact values are intentionally not copied into audit evidence.

## Inspection semantics

Internal event inspection resolves ownership from:

~~~text
validation.eventName
  -> project ownership resource
~~~

and returns:

~~~text
ownership
~~~

Ownership is current operational metadata.

It is not copied into historical Decision lineage, so changing ownership does not create or rewrite event decisions.

## Public event status

The authenticated project-scoped public event-status endpoint also exposes the same ownership resource:

~~~text
GET /api/v1/projects/:projectId/events/:eventId
~~~

This is useful for external project operators handling a runtime incident without requiring registry storage knowledge.

Ownership contains no credential material.

## Historical behavior

Ownership changes are deliberately current-state metadata:

~~~text
event decisionId = D1

team = accounts-platform
  -> change ownership
team = customer-platform

same historical event
  -> decisionId still D1
  -> ownership now customer-platform
~~~

This distinction is intentional.

Decision lineage answers what ETLayer decided at evaluation time.

Ownership answers who currently owns the semantic.

## Executable acceptance

The fast VS22 Cloudflare acceptance:

1. creates an isolated dynamic project;
2. creates a backend producer;
3. emits account.created@1;
4. proves ownership is initially absent;
5. configures team/domain/contacts;
6. proves requested/applied audit evidence;
7. proves raw contact values are absent from the audit record;
8. GETs normalized ownership;
9. inspects the already-processed event and proves ownership is visible without changing decisionId;
10. proves the authenticated public event-status surface exposes ownership;
11. submits reordered/duplicated equivalent contacts and proves changed=false;
12. changes the team and proves changed=true;
13. inspects the same event and proves current ownership changed while decisionId did not;
14. proves another project operator cannot read or write the ownership resource.

After merge, full regression extends to VS8 -> VS22.

## Non-goals

VS22 does not include:

- team/user directory;
- workspace membership;
- RBAC;
- authorization derived from ownership;
- per-version ownership;
- historical ownership snapshots in Decision lineage;
- on-call schedules;
- escalation policies;
- notification delivery;
- Event Catalog UI;
- governance metrics.

These can build on the first-class Ownership resource when a concrete product requirement appears.

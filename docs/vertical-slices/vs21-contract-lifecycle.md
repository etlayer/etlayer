# VS21: Contract Lifecycle - Published, Deprecated, Retired

**Status: complete and live-proven.**

Tracks GitHub issue #75.

Classification:

~~~text
A2-NOW-GOV/PRDT
Core - medium effort - do now
Governance + Product
~~~

## Risk

VS20 makes project-scoped contract versions immutable and publishable, but a published version otherwise remains usable forever.

That leaves no product-level distinction between:

- a currently supported contract version;
- a contract version that producers should migrate away from;
- a contract version that must no longer be accepted.

## Target invariant

~~~text
Published
  -> Deprecated
  -> Retired
~~~

Lifecycle transitions are monotonic.

~~~text
no resurrection
no direct Published -> Retired skip
same-state transition is idempotent
~~~

Runtime behavior is explicit:

~~~text
Published
  -> validate normally

Deprecated
  -> validate normally
  -> lifecycle state remains inspectable

Retired
  -> deterministic QUARANTINE
  -> contract_retired
  -> no destination routing
~~~

## Storage

Lifecycle state:

~~~text
registry/governance/<project>/contract-lifecycle/<event>/<version>.json
~~~

State:

~~~text
version
projectId
eventName
contractVersion
contractId
manifestDigest
status
publishedAt
updatedAt
deprecatedAt?
retiredAt?
~~~

The lifecycle summary is mutable because it represents current state.

Its mutations remain attributable through the existing append-only control-plane audit.

## Publication integration

VS20 publication initializes a newly published exact contract version with:

~~~text
status = published
~~~

Published contract versions created before VS21 remain compatible.

If lifecycle evidence does not exist yet, runtime resolution treats the immutable published contract as Published.

The first lifecycle mutation can materialize the initial Published lifecycle state from the immutable publication record before applying the transition.

## Management API

Project-operator authenticated mutations:

~~~text
POST /_mgmt/projects/:projectId/contracts/:eventName/:version/deprecate
POST /_mgmt/projects/:projectId/contracts/:eventName/:version/retire
~~~

Both use the VS15 audited mutation boundary.

Audit actions:

~~~text
contract.deprecate
contract.retire
~~~

Audit target includes:

~~~text
projectId
eventName
contractVersion
contractId
~~~

## Allowed transitions

~~~text
published -> deprecated
deprecated -> retired

deprecated -> deprecated
  idempotent

retired -> retired
  idempotent
~~~

Rejected:

~~~text
published -> retired
retired -> deprecated
deprecated -> published
retired -> published
~~~

There is no resurrection or rollback in VS21.

## Validation semantics

The contract validator semantics version advances to v2.

For a project-published contract ETLayer now records:

~~~text
contractStatus
governanceManifestDigest
~~~

in validation evidence.

Validation state advances to v4 so lifecycle context is durable and visible through internal event inspection.

Built-in contracts do not acquire lifecycle state in VS21.

## Deprecated behavior

Deprecated is advisory at runtime.

An otherwise-valid event remains:

~~~text
validation = valid
decision = allow
~~~

while internal inspection makes the lifecycle state explicit:

~~~text
contractStatus = deprecated
~~~

This allows producers to migrate without an immediate data-plane outage.

## Retired behavior

A Retired exact project contract version is rejected before payload contract constraints are evaluated:

~~~text
validation = quarantined
error.code = contract_retired
contractStatus = retired
decision = quarantine
deliveries = []
~~~

Retirement therefore changes future runtime acceptance without rewriting historical decisions.

## Historical decisions

Lifecycle transitions are control-plane mutations.

They do not automatically revalidate preserved events.

Therefore:

~~~text
historical event
old decisionId

deprecate / retire

historical event inspection
same decisionId
~~~

An explicit later revalidation remains the mechanism for creating new decision lineage.

## Executable acceptance

The fast VS21 Cloudflare acceptance:

1. creates an isolated dynamic project;
2. creates a backend producer;
3. emits account.created@1 and records the historical decision ID;
4. plans and publishes account.created@2 through the VS20 path;
5. emits valid v2 and proves Published + VALID + ALLOW;
6. deprecates v2;
7. proves append-only control-plane audit evidence;
8. emits valid v2 and proves Deprecated + VALID + ALLOW;
9. retires v2;
10. proves append-only control-plane audit evidence;
11. emits an otherwise-valid v2 event;
12. proves Retired + QUARANTINE + contract_retired + no delivery;
13. proves Retired -> Deprecated resurrection is rejected;
14. proves repeated Retire is idempotent;
15. proves historical v1 decision ID is unchanged.

After merge, full regression extends the accumulated proof to VS8 -> VS21.

## Non-goals

VS21 does not include:

- Draft or Review lifecycle;
- multi-party approval;
- automatic producer migration;
- automatic historical revalidation;
- unpublish/delete;
- rollback/resurrection;
- environment promotion;
- ownership metadata;
- governance metrics;
- lifecycle UI.

Git + Governance-as-Code remain the reviewable pre-publication workflow.

VS21 only defines the operational lifecycle of a contract after publication.


---

# Completion evidence

VS21 completed with:

~~~text
implementation PR              #76
merged main commit             f02cd5e3b3b1222f8381ad3f518218e72479f42e
PR CI                          green
fast slice live acceptance     green
slice acceptance run           #36180682715
post-merge main CI             green
post-merge CI run              #36181006389
full VS8 -> VS21 regression    green
full regression run            #36181006381
~~~

Fast live proof:

~~~text
correlationId
vs21-20260925-193624-2222c086

projectId
vs21-20260925-193624-2222c086

manifestDigest
7f21bdaffc9a0cf691e205fdf4bb075300139a4e30b04276c6114a9b393f770a

publicationOperationId
56a887de-f7f4-43c3-abf0-afbe2b87a236

deprecateOperationId
393ecdcd-4676-4dde-894c-34c671bf5c7f

retireOperationId
1f42e61f-fbb0-4dcc-a635-56f87f7b7bac
~~~

Observed lifecycle proof:

~~~text
Published   -> valid / allow
Deprecated  -> valid / allow
Retired     -> quarantined / contract_retired

deprecatedStillAllowed             true
retiredQuarantined                 true
resurrectionRejected               true
idempotentRetire                   true
historicalDecisionLineageMutated   false
~~~

The post-merge full regression re-proved the accumulated Cloudflare runtime sequence through VS21 on main.

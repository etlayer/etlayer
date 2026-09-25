# VS20: Guarded Governance Publication by Manifest Digest

**Status: complete and live-proven.**

Tracks GitHub issue #72.

Classification:

~~~text
A2-NOW-GOV/SEC
Core - medium effort - do now
Governance + Security
~~~

## Risk

VS19 gives ETLayer one deterministic governance artifact and one stable manifestDigest, but planning alone does not make a proposed contract available to runtime validation.

A publication path must not introduce a second representation or allow content drift between what was reviewed/planned and what is installed.

## Target invariant

~~~text
ProjectGovernance/v1
  -> normalize
  -> manifestDigest
  -> historical plan

publish
  -> recompute exact digest
  -> require same manifestDigest
  -> require explicit acknowledgement for breaking plan
  -> append immutable publication
  -> install immutable project-scoped contract versions

runtime event with explicit schema version
  -> published project contract first
  -> built-in contract fallback
~~~

Publication itself does not revalidate historical events, rewrite decisions, or trigger delivery.

## API

Project operator mutation:

~~~text
POST /_mgmt/projects/:projectId/governance/publish
Authorization: Bearer <project-operator>
Content-Type: application/json
~~~

Request:

~~~json
{
  "manifestDigest": "<sha256>",
  "acknowledgeBreaking": true,
  "manifest": {
    "apiVersion": "etlayer.dev/v1",
    "kind": "ProjectGovernance",
    "projectId": "customer-a",
    "contracts": []
  }
}
~~~

The route project and manifest project must match.

## Guard conditions

Before any publication record is written:

1. authenticate the project operator;
2. normalize the supplied manifest;
3. run the current VS19 historical governance plan;
4. recompute manifestDigest from normalized semantics;
5. reject digest mismatch;
6. reject a breaking plan unless acknowledgeBreaking is exactly true;
7. execute the mutation through the VS15 control-plane audit boundary.

Rejected publication attempts can therefore be audited without creating contract/publication state.

## Storage

Project-scoped contract versions:

~~~text
registry/governance/<project>/contracts/<event>/<version>.json
~~~

Publication records:

~~~text
registry/governance/<project>/publications/<manifestDigest>.json
~~~

Both are create-only.

The publication record captures:

~~~text
manifestDigest
projectId
publishedAt
compatible
selected
changed
normalized manifest
~~~

A contract record captures the exact proposed contract and the manifest digest that first published it.

The same exact contract version can be reused by a later manifest. Different content for the same project/event/version is a conflict.

## Runtime resolution

Events already carry an explicit:

~~~text
etlayer.schema.version
~~~

No mutable "current version" pointer is introduced.

During processing ETLayer resolves:

~~~text
projectId + eventName + schemaVersion
  -> project-published exact contract, if present
  -> otherwise built-in contract catalog
~~~

This keeps version selection explicit and makes publication additive.

## Idempotency

Publishing the exact same manifestDigest repeatedly returns the existing logical publication.

It does not append a second publication record or replace the immutable contract version.

The control-plane audit can still record the repeated authenticated mutation attempt.

## Historical behavior

Publication does not automatically re-run old events.

Therefore:

~~~text
old event
old decisionId
publication
old event inspection
same decisionId
~~~

A later explicit revalidation remains a separate operation with separate decision lineage.

## Executable acceptance

The fast VS20 Cloudflare acceptance:

1. creates an isolated dynamic project;
2. creates a backend producer;
3. emits account.created@1 and proves ALLOW under the built-in v1 contract;
4. plans account.created@2 requiring plan.id;
5. proves the plan is backward-breaking and would move the historical v1 event from ALLOW to QUARANTINE;
6. attempts publication with a wrong digest and proves rejection;
7. attempts the exact breaking publication without acknowledgement and proves rejection;
8. publishes the exact planned manifest with acknowledgement;
9. proves append-only requested/applied control-plane audit evidence;
10. emits schema v2 with plan.id and proves VALID + ALLOW under account.created@2;
11. emits schema v2 without plan.id and proves QUARANTINE under account.created@2;
12. inspects the original v1 event and proves decisionId is unchanged;
13. republishes the same digest and proves idempotent result.

After merge, the full regression adds VS20 to the VS8 -> VS20 serial proof.

## Non-goals

VS20 does not include:

- automatic historical revalidation;
- rollback or unpublish;
- mutable current-contract pointers;
- environment promotion;
- multi-party approval;
- signed manifests;
- Git attestations;
- privacy or authority policy publication;
- arbitrary policy language;
- dashboard/UI.

The next slice should be chosen from a real operational/product need over this now-published governance substrate, rather than adding workflow machinery speculatively.


---

# Completion evidence

VS20 completed with:

~~~text
implementation PR              #73
merged main commit             0d7e4feb5bc14af468f00615e6033b557a4e68fb
PR CI                          green
fast slice live acceptance     green
slice acceptance run           #36177195839
post-merge main CI             green
post-merge CI run              #36177462819
full VS8 -> VS20 regression    green
full regression run            #36177462836
~~~

Fast live proof:

~~~text
correlationId
vs20-20260925-190232-eb48063b

projectId
vs20-20260925-190232-eb48063b

manifestDigest
1c7e4406be10084f0a9edd14516fb38834c24a06a416205cc95ad12b534c4cc5

publicationOperationId
a1285759-48c8-41e9-8f8c-24bdb53510fc

v1EventId
ddb4be33-b400-4623-a8f4-dd3d2c8d55ef

v2AllowEventId
436e52f5-c8f1-41c7-bbd7-7fb23d2b3901

v2QuarantineEventId
fceda2c4-7b24-429e-98ee-c7e027aff3b8
~~~

The proof established:

~~~text
wrongDigestRejected                  true
breakingAcknowledgementRequired      true
publishedContractId                  account.created@2
historicalDecisionLineageMutated     false
idempotentRepublish                  true
~~~

The post-merge full regression then re-proved the accumulated Cloudflare runtime sequence through VS20 on main.

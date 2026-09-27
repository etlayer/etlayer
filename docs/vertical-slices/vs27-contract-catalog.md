# VS27: Supported Contract Catalog / Discovery

**Status: complete and live-proven.**

Tracks GitHub issue #101.

## Risk

VS26 exposes an exact supported contract artifact, but a generic external consumer must already know the event name and version.

Without a supported discovery boundary, UI, CLI, MCP, and SDK consumers would need prior knowledge or would be tempted to use internal management, operations, storage, or implementation surfaces.

## Target invariant

~~~text
project operator
  -> supported public contract catalog
  -> deterministic effective contract coordinates
  -> exact VS26 artifact links

without:
  prior event/version knowledge
  /_mgmt
  /_ops
  R2 keys
  implementation imports
  second persisted catalog
~~~

## Public boundary

~~~text
GET /api/v1/projects/:projectId/contracts
Authorization: Bearer <project-operator>
~~~

Response shape:

~~~json
{
  "apiVersion": "v1",
  "kind": "ContractCatalog",
  "projectId": "customer-a",
  "contracts": [
    {
      "eventName": "account.created",
      "version": 1,
      "source": "builtin",
      "lifecycle": null,
      "links": {
        "self": "https://.../contracts/account.created/1"
      }
    },
    {
      "eventName": "account.created",
      "version": 2,
      "source": "project",
      "lifecycle": "deprecated",
      "links": {
        "self": "https://.../contracts/account.created/2"
      }
    }
  ],
  "links": {
    "self": "https://.../contracts",
    "project": "https://.../projects/customer-a"
  }
}
~~~

## Effective catalog semantics

The catalog is a read model, not durable state.

~~~text
built-in contracts
  + project-published exact coordinates
  + current project lifecycle
  -> effective catalog
~~~

If a project-published contract exists at the same exact event/version coordinate as a built-in contract, the project contract wins. This matches VS26 exact resolution.

Ordering is deterministic:

~~~text
eventName ascending
then version ascending
~~~

## Bounded discovery

Project-published contracts are discovered from the authoritative governance contract prefix. The read is bounded to avoid an unbounded R2 scan.

No second index or persisted catalog is introduced in this slice.

## Authentication

The endpoint reuses project-operator authentication:

~~~text
correct project operator -> 200
operator for another project -> 401 invalid_operator_credential
unknown project -> 404 project_not_found
~~~

## Executable acceptance

1. deploy the current Worker;
2. create an isolated dynamic project;
3. publish account.created@2;
4. deprecate v2;
5. read the catalog twice;
6. prove built-in account.created@1 is discoverable;
7. prove project account.created@2 is discoverable with deprecated lifecycle;
8. prove deterministic ordering and byte-identical repeated reads;
9. follow both exact artifact links and prove they resolve through VS26;
10. prove no internal URLs, registry keys, credentials, or secret fields are exposed;
11. prove another project operator cannot read the catalog;
12. preserve VS8 -> VS27 accumulated regression.

## Non-goals

- search or semantic search;
- pagination;
- ownership joins;
- generated source blobs;
- consumer/dependency impact analysis;
- OpenAPI;
- packaged SDK;
- UI;
- MCP;
- Workspace/Environment identity.


---

# Completion evidence

VS27 completed with:

~~~text
tracking issue                       #101
implementation PR                    #102
merged implementation commit         225351d11882bc901eb25b3b70b17852c7557405
PR CI                                green
fast slice live acceptance           green
fast live acceptance run             #36289712682
post-merge main CI                   green
post-merge main CI run               #36289764920
full VS8 -> VS27 regression          green
full regression run                  #36289764895
~~~

Fast live proof:

~~~text
correlationId
vs27-20260927-025127-39a992b5

builtinV1Discoverable                true
projectV2Discoverable                true
projectV2Lifecycle                   deprecated
deterministicOrdering                true
byteStableRead                       true
exactArtifactLinksResolve            true
secretFieldsExposed                  false
crossProjectIsolation                true
~~~

Final accumulated proof:

~~~text
correlationId
vs27-20260927-031421-344f85a5

builtinV1Discoverable                true
projectV2Discoverable                true
projectV2Lifecycle                   deprecated
deterministicOrdering                true
byteStableRead                       true
exactArtifactLinksResolve            true
secretFieldsExposed                  false
crossProjectIsolation                true

Full live regression passed: VS8 -> VS27
~~~

The catalog remains a derived read model over built-in contracts and authoritative project publication/lifecycle state. No second persisted catalog or internal product API was introduced.

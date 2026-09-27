# VS26: Typed Contract Artifact and TypeScript Generation

**Status: complete and live-proven.**

Tracks GitHub issue #94.

Classification:

~~~text
A1-NOW-DX/API
Core - small-to-medium effort - do now
Developer Experience + API
~~~

## Risk

ETLayer contracts are authoritative inside runtime validation and governance, but external developers still lack a supported machine-readable contract endpoint and deterministic typed artifact generation.

Without a product boundary, SDK/codegen would either import ETLayer implementation modules or copy contracts into a second schema language.

## Target invariant

~~~text
authoritative ETLayer contract
  -> supported public artifact
  -> deterministic TypeScript module

generated type/validator
  derives from
  the exact ETLayer contract language

no copied schema language
no implementation-package import
~~~

## Supported public contract artifact

Project-operator authenticated endpoint:

~~~text
GET /api/v1/projects/:projectId/contracts/:eventName/:version
~~~

Resolution order:

~~~text
exact project-published version
  -> source = project

otherwise exact built-in version
  -> source = builtin

otherwise
  -> 404 contract_not_found
~~~

Project-published response:

~~~json
{
  "apiVersion": "v1",
  "kind": "Contract",
  "projectId": "customer-a",
  "source": "project",
  "contract": {
    "id": "account.created@2",
    "eventName": "account.created",
    "version": 2,
    "required": {},
    "forbidden": []
  },
  "lifecycle": {
    "status": "deprecated",
    "manifestDigest": "...",
    "publishedAt": "..."
  },
  "links": {
    "self": "...",
    "project": "..."
  }
}
~~~

Built-in contracts expose:

~~~text
source = builtin
lifecycle = null
~~~

The response does not expose registry keys, credentials, secret environment names, internal management links, or internal ops links.

## Contract normalization

The public artifact normalizes the existing ETLayer contract language:

- required attributes sorted by name;
- forbidden attributes deduplicated and sorted;
- only `type` and `const` constraints preserved;
- contract ID synthesized only when absent.

This does not introduce a new schema language.

It makes the existing language deterministic for downstream generation.

## TypeScript generation

CLI:

~~~text
npm run contract:generate --   --file contract-artifact.json   --out account-created-v2.ts
~~~

Without `--out`, generated source is written to stdout.

Generated source contains:

~~~text
eventName
schemaVersion
contract
<ContractName>Attributes
validate<ContractName>Attributes
~~~

Example:

~~~ts
export const eventName =
  "account.created" as const;

export const schemaVersion =
  2 as const;

export type AccountCreatedV2Attributes = {
  "account.id": string;
  "etlayer.producer.kind":
    typeof contract.required[
      "etlayer.producer.kind"
    ]["const"];
  "experiment.id"?: never;
  [key: string]: unknown;
};
~~~

The output is standalone.

It imports no ETLayer package or implementation module.

## Type mapping

When no `const` constraint exists:

~~~text
string  -> string
number  -> number
integer -> number
boolean -> boolean
object  -> Record<string, unknown>
other   -> unknown
~~~

When `const` exists, the generated type derives directly from the generated immutable contract object.

## Runtime validator

The generated type guard mirrors ETLayer's existing required/forbidden constraint subset:

- required presence;
- primitive type;
- safe integer;
- const equality;
- forbidden attribute absence.

The generator does not add validation semantics that ETLayer itself does not have.

## Determinism

Generation contains no:

- timestamp;
- absolute path;
- machine identifier;
- random value.

Semantically equivalent normalized contract input produces identical generated source.

This allows generated artifacts to be checked into repositories and reviewed as normal source changes.

## Authentication

The contract artifact endpoint reuses the existing project-operator public API boundary.

~~~text
correct project operator
  -> 200

operator for another project
  -> 401 invalid_operator_credential

unknown project
  -> 404 project_not_found

known project, unknown exact contract
  -> 404 contract_not_found
~~~

## Executable acceptance

The fast VS26 Cloudflare acceptance:

1. deploys the current Worker;
2. creates an isolated dynamic project;
3. plans and publishes account.created@2;
4. deprecates v2;
5. reads v2 through the supported contract artifact endpoint;
6. proves source=project and lifecycle=deprecated with the exact manifestDigest;
7. reads account.created@1 and proves source=builtin/lifecycle=null;
8. proves artifacts expose no internal URLs, registry paths, credential, or secret fields;
9. generates TypeScript twice from the v2 artifact;
10. proves generated output is byte-identical;
11. proves generated source imports no ETLayer implementation package;
12. executes the generated TypeScript validator using Node type stripping;
13. proves a valid object passes and an object containing a forbidden attribute fails;
14. proves another project operator cannot read the artifact;
15. proves an unknown exact contract returns stable `contract_not_found`.

After merge, full regression extends the accumulated runtime proof to VS8 -> VS26.

## Non-goals

VS26 does not include:

- npm package publication;
- multi-language generation;
- network client SDK;
- event emit helper;
- OpenAPI generation;
- contract inference;
- semantic contract search;
- workspace/account model;
- environment-promotion artifact identity.

Those should build on the supported contract artifact only when a concrete developer workflow requires them.


---

# Completion evidence

VS26 completed with:

~~~text
implementation PR                    #95
merged implementation commit         9967ef25951863b4a13808d8e60ff5006f22c0ea
fast slice live acceptance           green
fast live acceptance run             #36261574813
VS24 transport hardening             #96
workers.dev hostname cutover         #98
VS24 credential propagation fix      #99
final proof main commit              e69f39865cf5babb2b0f2b2273e4316ae83de00f
final main CI                        green
final main CI run                    #36287575273
full VS8 -> VS26 regression          green
full regression run                  #36287575348 attempt 2
~~~

Final live proof:

~~~text
correlationId
vs26-20260927-023618-e9f2bb14

projectContractSource                 project
projectContractStatus                 deprecated
builtinContractSource                 builtin
generatedTypeScriptDeterministic      true
generatedValidatorExecuted            true
generatedImplementationImports        false
secretFieldsExposed                   false
crossProjectIsolation                 true
unknownContractStable404              true
~~~

The first full-regression attempt after the VS24 propagation fix encountered a one-off Cloudflare Worker error 1101 during the already-proven VS13 bootstrap path. Cloudflare reported no persistent Worker issue, and an identical rerun on the same main SHA passed VS13 and the full VS8 -> VS26 suite without any runtime change.

The final proof therefore distinguishes the permanent VS24 acceptance race fixed in PR #99 from the non-reproducible Cloudflare execution transient.

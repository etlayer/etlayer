# VS15: Append-only Control-plane Audit Log

**Status: complete and live-proven.**

Tracks GitHub issue #50.

Classification:

~~~text
A1-NOW-GOV/SEC
Core - small effort - do now
Governance + Security
~~~

## Risk

ETLayer already keeps append-only event decision lineage, but control-plane state such as projects, producers, destinations, and encrypted destination credentials is mutable.

Before VS15 an operator could inspect the current state but could not reliably answer:

~~~text
who changed it?
what action was authorized?
which resource was targeted?
did the operation actually apply?
~~~

## Target invariant

No authenticated internal management mutation proceeds without durable append-only audit intent.

A successful mutation produces:

~~~text
requested
   |
   v
mutation
   |
   v
applied
~~~

A domain failure produces:

~~~text
requested
   |
   v
mutation fails
   |
   v
failed
~~~

The three phases are immutable objects. Audit evidence is never rewritten.

## Why two phases

R2 does not provide a transaction spanning an arbitrary registry mutation and a second audit object.

Writing only after the mutation creates a silent gap:

~~~text
mutation succeeds
audit write fails
=> changed state with no evidence
~~~

VS15 therefore writes durable intent first.

If the post-mutation audit write fails, the requested record remains visible. The operation is therefore ambiguous but not invisible and can be reconciled.

## Storage model

~~~text
registry/
  audit/
    <operation-id>/
      requested.json
      applied.json
      failed.json
~~~

Only one terminal phase is expected:

~~~text
requested + applied
or
requested + failed
~~~

Each record contains:

- version;
- operationId;
- phase;
- recordedAt;
- actor;
- action;
- target;
- request method/path;
- safe change summary;
- failure class for failed operations.

## Actor model

Current actors are intentionally minimal and match the current credential model.

Global management:

~~~json
{
  "kind": "management",
  "scope": "global"
}
~~~

Project operator:

~~~json
{
  "kind": "project_operator",
  "projectId": "customer-a",
  "source": "registry"
}
~~~

Future workspace users, service accounts, and agents can extend this actor shape without changing the operation model.

## Secret boundary

Audit evidence must never persist:

- Authorization headers;
- management credentials;
- operator credentials;
- producer credentials;
- provider secrets;
- ciphertext;
- tokens.

The audit serializer defensively removes fields whose keys contain secret, credential, authorization, ciphertext, or token.

Call sites also pass only semantic summaries rather than raw request bodies.

## Audited internal management mutations

VS15 covers the current mutating /_mgmt surface:

- project create;
- internal project onboarding;
- producer create;
- producer credential rotation;
- producer disable;
- destination enable/disable;
- destination credential configure;
- destination credential disable;
- destination credential bootstrap from runtime default;
- destination credential rewrap.

Successful mutation responses include:

~~~text
x-etlayer-operation-id: <operation-id>
~~~

This provides a direct correlation coordinate without changing JSON response bodies.

## Public onboarding boundary

The versioned public onboarding endpoint from VS12 already has its own encrypted idempotency operation evidence and replay semantics.

VS15 does not silently wrap that endpoint with a second random audit operation ID because retries must preserve one logical operation identity. Unifying public idempotency evidence with the control-plane audit model requires a deterministic operation identity tied to the idempotency record and is a separate follow-up.

This limitation is explicit rather than hidden.

## Executable acceptance

The live Cloudflare acceptance creates an isolated project and proves:

1. project create -> requested + applied;
2. producer create -> requested + applied;
3. destination enable -> requested + applied;
4. producer credential rotate -> requested + applied;
5. producer disable -> requested + applied;
6. management/project-operator actor attribution is correct;
7. every successful response exposes x-etlayer-operation-id;
8. exact audit evidence is readable through the privileged registry evidence path;
9. raw management/operator/producer credentials are absent from audit evidence;
10. cross-project unauthorized mutation returns 401 and exposes no operation ID;
11. VS8 -> VS14 remain green.

## Non-goals

VS15 does not include:

- audit search/list UI;
- retention policy;
- workspace users or RBAC;
- public audit API;
- SIEM export;
- audit analytics;
- public onboarding/idempotency unification;
- transactional storage migration.


---

# Completion evidence

VS15 completed with:

~~~text
PR CI                 green
Live Acceptance #95  green
suite                 VS8 -> VS15
runtime head          0b793fcf834f05367e4f7593c14244544859f3fc
~~~

Final live correlation:

~~~text
vs15-20260924-134142-8888fe66
~~~

Project:

~~~text
vs15-20260924-134142-8888fe66-a
~~~

Representative operation IDs:

~~~text
project.create
caeccfbd-6740-4cf4-899c-54b253643115

producer.create
d1a0b546-6bb0-4e37-b143-4f3e7704b5b8

destination.configure
ddab43eb-cd64-47a7-90e8-10096c4b2738

producer.rotate
115b96c5-01a1-48eb-ab31-8ac448661466

producer.disable
c3a534c0-2be9-434c-97f1-ceaa75919850
~~~

The live run proved:

~~~text
successful mutation
  -> x-etlayer-operation-id
  -> requested evidence
  -> applied evidence

global mutation
  -> actor = management

project mutation
  -> actor = project_operator
  -> projectId attributed

audit evidence
  -> no raw management credential
  -> no raw operator credential
  -> no raw producer credential

cross-project unauthorized mutation
  -> HTTP 401
  -> no operation ID
~~~

The successful runtime SHA is recorded separately because the final completion commit only updates documentation.

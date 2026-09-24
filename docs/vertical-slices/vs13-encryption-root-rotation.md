# VS13: Versioned Encryption Roots & Safe Rotation

**Status: design selected; implementation not started.**

Tracks GitHub issue #43.

## Purpose

ETLayer already persists encrypted durable state with a keyVersion field.

VS13 makes that version meaningful operationally.

The slice proves that ETLayer can introduce v2 roots, continue reading v1 records, move new writes to v2, migrate long-lived destination credentials, drain bounded idempotency capsules, and determine when v1 is actually safe to remove.

## Core invariant

~~~text
old encrypted state
  remains decryptable

new encrypted state
  uses the selected active version

long-lived state
  can migrate append-only

old roots
  are removed only after machine-verifiable readiness
~~~

## Existing domains

### Destination credentials

Current durable records include:

~~~text
algorithm = AES-256-GCM
keyVersion = v1
iv
ciphertext
~~~

The provider credential is long-lived and can be needed for:

- normal delivery;
- replay;
- future retries.

A root-key migration must preserve provider credential value while producing a new encrypted version.

### Public idempotency capsules

Current durable records include:

~~~text
algorithm = AES-256-GCM
keyVersion = v1
replayUntil
iv
ciphertext
~~~

Their plaintext contains the secret-bearing public response necessary for retrying a lost onboarding response.

Their lifetime is bounded.

That makes expiry drain preferable to bulk migration.

---

# Versioned keyring

Introduce a small shared encryption-root resolver.

Example conceptual API:

~~~text
resolveRootKey({
  domain: "destination" | "idempotency",
  version: "v1" | "v2",
  env,
  crypto
})
~~~

Supported environment bindings:

~~~text
ETLAYER_DESTINATION_SECRET_KEY_V1
ETLAYER_DESTINATION_SECRET_KEY_V2

ETLAYER_IDEMPOTENCY_SECRET_KEY_V1
ETLAYER_IDEMPOTENCY_SECRET_KEY_V2
~~~

The module must validate:

- supported domain;
- supported version;
- secret exists;
- decoded root is exactly 32 bytes;
- Web Crypto support.

No caller should contain its own v1/v2 environment-name switch after the refactor.

## Active write version

Each domain needs an explicit active write version.

Recommended non-secret configuration:

~~~text
ETLAYER_DESTINATION_SECRET_ACTIVE_VERSION=v2
ETLAYER_IDEMPOTENCY_SECRET_ACTIVE_VERSION=v2
~~~

Default compatibility behavior during rollout may remain v1 when the setting is absent, but acceptance must prove explicit switching.

Writes select the active version.

Reads always select the version persisted in the record.

This separation is fundamental:

~~~text
write version != historical read version
~~~

---

# Destination credential rewrap

## Definition

Rewrap means:

> Decrypt the currently active provider credential under its historical root and encrypt the exact same provider secret under the target root version.

It is not provider credential rotation.

## Append-only behavior

Current credential versions remain immutable.

A rewrap creates a new version record with a new internal credential ID.

Representative metadata:

~~~json
{
  "version": 2,
  "kind": "destination_credential",
  "projectId": "customer-a",
  "destination": "posthog",
  "credentialId": "new-internal-id",
  "algorithm": "AES-256-GCM",
  "keyVersion": "v2",
  "rotationKind": "master_key_rewrap",
  "supersedesCredentialId": "previous-internal-id",
  "createdAt": "..."
}
~~~

The exact record schema version may differ, but the semantic distinction is required.

## Safe sequence

~~~text
read current pointer
  |
read current encrypted record
  |
decrypt with record.keyVersion
  |
encrypt same plaintext with target version
  |
create new immutable encrypted record
  |
verify new record can decrypt
  |
advance current pointer
~~~

If any step before pointer advancement fails, the old pointer remains authoritative.

The pointer must never reference a record that was not durably written.

## Idempotency

A rewrap request should be safely repeatable.

If the current pointer already targets the requested key version, return a no-op/success result rather than creating endless equivalent versions.

Concurrent rewraps should converge safely or conflict explicitly.

A broad distributed transaction framework is not required.

---

# Idempotency capsule rotation

Idempotency response capsules already expire.

Do not migrate expired capsules.

## Write transition

After active idempotency version becomes v2:

~~~text
new capsule -> v2
old capsule -> stays v1
~~~

## Read transition

During the overlap:

~~~text
v1 capsule -> decrypt with v1
v2 capsule -> decrypt with v2
~~~

The replay semantics remain unchanged.

## Drain

v1 stays required until no unexpired v1 capsule remains.

After that:

~~~text
v1 idempotency root
  -> retirement-safe
~~~

Deleting old capsule objects is not required for this slice. Expired ciphertext may remain as historical/operational residue according to future retention policy; it simply no longer blocks decryptability guarantees.

---

# Key usage audit

VS13 must implement a machine-readable management-time audit.

Conceptual result:

~~~json
{
  "destination": {
    "v1": {
      "activePointers": 2,
      "retirementSafe": false
    },
    "v2": {
      "activePointers": 5,
      "retirementSafe": false
    }
  },
  "idempotency": {
    "v1": {
      "unexpiredCapsules": 1,
      "retirementSafe": false
    },
    "v2": {
      "unexpiredCapsules": 3,
      "retirementSafe": false
    }
  }
}
~~~

Exact response shape may change.

## Storage scan

At current scale, a rare privileged R2 list/scan is acceptable.

This is not on the hot event path.

The audit should inspect authoritative durable state, not an eventually-maintained convenience counter.

A future larger-scale implementation can replace the scan with indexed manifests if required.

---

# Internal management surface

No /api/v1 key administration is added.

Candidate privileged operations:

~~~text
GET  /_mgmt/encryption/key-usage

POST /_mgmt/projects/:projectId/destinations/:destination/credential/rewrap
{
  "targetKeyVersion": "v2"
}
~~~

Global management authority is appropriate because root lifecycle affects infrastructure-level decryptability.

Project operator credentials must not be able to select or retire encryption roots.

---

# Retirement runbook semantics

VS13 does not need to delete Cloudflare secrets itself.

It must make the safe operator sequence explicit.

## Destination root rotation

~~~text
1. provision DESTINATION V2 root
2. deploy code that can read V1 + V2
3. set active destination write version = v2
4. prove new writes use v2
5. rewrap active destination credentials
6. audit key usage
7. require v1 activePointers = 0
8. only then remove V1 root
9. run delivery + replay proof
~~~

## Idempotency root rotation

~~~text
1. provision IDEMPOTENCY V2 root
2. deploy code that can read V1 + V2
3. set active idempotency write version = v2
4. prove new capsules use v2
5. keep V1 while any v1 capsule is unexpired
6. audit until v1 unexpiredCapsules = 0
7. only then remove V1 root
8. prove current public onboarding/replay still works
~~~

The system should clearly fail configuration validation if a still-required record references a missing root.

---

# Failure cases

VS13 tests must cover at least:

- persisted v1 record with both roots present;
- persisted v2 record with both roots present;
- missing historical v1 root while active v1 destination pointer exists;
- missing v1 root while unexpired v1 idempotency capsule exists;
- target v2 root missing during rewrap;
- ciphertext transplant/AAD mismatch remains rejected;
- pointer does not advance when new encryption fails;
- repeated rewrap to already-active version is safe;
- old encrypted version remains after migration;
- plaintext secret never appears in stored metadata/logs.

---

# Live acceptance

Use isolated CI projects and roots.

The acceptance harness should not overwrite v1 in place.

## Phase A - establish v1 state

1. provision stable destination/idempotency v1 roots;
2. provision v2 roots but keep active write versions on v1;
3. create project A;
4. configure PostHog provider credential under destination v1;
5. complete public onboarding under idempotency v1;
6. emit a real event;
7. prove delivery/status/replay work.

## Phase B - switch new writes

8. change active write versions to v2;
9. deploy without removing v1;
10. create project B destination credential and prove keyVersion = v2;
11. create a new onboarding/idempotency operation and prove keyVersion = v2;
12. replay the existing project A v1 capsule and prove it still works;
13. deliver/replay using project A v1 destination credential and prove it still works.

## Phase C - migrate long-lived destination state

14. run project A destination rewrap to v2;
15. prove provider secret value is unchanged indirectly through successful provider delivery;
16. prove new encrypted record has keyVersion = v2;
17. prove rotationKind/supersedes lineage;
18. prove current pointer references the v2 record;
19. prove original v1 encrypted record still exists;
20. prove delivery + replay still work.

## Phase D - retirement readiness

21. audit destination v1 before migration and prove retirementSafe = false;
22. audit after all active acceptance pointers migrate and prove destination v1 retirementSafe = true;
23. audit idempotency v1 while original capsule is unexpired and prove false;
24. advance controlled acceptance time beyond replayUntil and prove idempotency v1 retirementSafe = true.

## Phase E - old-root removal proof

25. deploy/execute acceptance configuration without v1 roots only after both domains report retirement-safe;
26. prove v2 destination delivery works;
27. prove current v2 public onboarding/idempotency replay works;
28. run VS8 -> VS12 regression suite with the versioned keyring model.

---

# Security properties

## Domain separation

Destination and idempotency roots remain separate.

Do not introduce one universal ETLayer encryption root.

AAD continues to include domain-specific coordinates and key version.

## Historical evidence

Old encrypted versions are not silently rewritten.

For destination credentials, rewrap is append-only.

For expired idempotency records, retention/deletion remains a future policy decision.

## Plaintext handling

Plaintext exists only transiently in memory during decrypt/rewrap.

Do not:

- persist plaintext;
- log plaintext;
- return provider credentials from key-management operations;
- expose root material through management responses.

---

# Non-goals

VS13 does not include:

- cloud KMS provider abstraction;
- HSM support;
- BYOK/BYOKMS customer keys;
- automatic scheduled rotation;
- provider credential rotation;
- project-operator key administration;
- public /api/v1 key-management endpoints;
- arbitrary secrets vault;
- accounts/workspaces/RBAC;
- billing;
- dashboard UI;
- deletion/retention policy for all historical encrypted objects.

---

# Definition of done

~~~text
shared versioned key resolver          proven
v1 + v2 simultaneous reads            proven
explicit active write versions        proven

destination:
  new v2 writes                        proven
  v1 historical read                   proven
  append-only v1 -> v2 rewrap          proven
  pointer safety                       proven
  provider secret unchanged            proven
  delivery/replay after rewrap         proven
  retirement readiness                 proven

idempotency:
  new v2 writes                        proven
  unexpired v1 replay                  proven
  expiry drain                         proven
  retirement readiness                 proven

old-root removal after readiness       proven
plaintext non-persistence              proven
VS8 -> VS12 regressions                green
~~~

At completion, ETLayer will have a real encryption-key lifecycle rather than merely version-labelled ciphertext.

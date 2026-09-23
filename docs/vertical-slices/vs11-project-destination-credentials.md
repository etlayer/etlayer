# VS11: Project-scoped destination credentials

**Status: VS11 complete; isolated Cloudflare credential acceptance and independent PostHog verification passed on 2026-09-23.**

## Goal

Allow different dynamic ETLayer projects to use different provider credentials without storing provider secrets in plaintext or falling back to Worker-global destination tokens.

VS9 made destination enablement project-scoped. VS11 makes destination authentication project-scoped as well.

## Core invariant

```text
project A PostHog credential != project B PostHog credential

dynamic project delivery
  -> resolve project credential
  -> decrypt only at delivery time
  -> call destination adapter

no project credential
  -> do not fall back to Worker-global token
```

Static reference projects keep their existing Worker-secret behavior for backward compatibility.

## Storage model

Credential versions are append-only:

```text
registry/destination-credentials/<project>/<destination>/versions/<credential-id>.json
```

The active pointer is mutable:

```text
registry/destination-credentials/<project>/<destination>/current.json
```

A version record contains:

```text
version
projectId
destination
credentialId
algorithm = AES-256-GCM
keyVersion = v1
iv
ciphertext
createdAt
```

The plaintext secret is not stored.

The pointer contains only metadata:

```text
credentialId
status = active | disabled
keyVersion
versionKey
updatedAt
```

## Encryption

VS11 uses Web Crypto AES-256-GCM.

The Worker master key is:

```text
ETLAYER_DESTINATION_SECRET_KEY_V1
```

It must decode to exactly 32 bytes.

The implementation accepts either:

- 64 hexadecimal characters; or
- base64url encoding of 32 bytes.

Each credential version uses a fresh 96-bit random IV.

Additional authenticated data binds the ciphertext to:

```text
ETLayer destination credential format version
projectId
destination
credentialId
keyVersion
```

Therefore copying a ciphertext record into another project or destination does not produce a decryptable credential.

## Master key lifecycle

Provider credential rotation and encryption-master-key rotation are deliberately separate.

### Provider credential rotation

Supported in VS11.

```text
write new encrypted credential version
  -> advance current pointer
  -> old encrypted version remains historical
```

The old provider credential stops being used as soon as the current pointer advances.

### Master key rotation

Not implemented in VS11.

Do **not** overwrite `ETLAYER_DESTINATION_SECRET_KEY_V1` in a persistent environment while active or historical `v1` records must remain decryptable.

A future master-key rotation flow should introduce a new key version, for example:

```text
ETLAYER_DESTINATION_SECRET_KEY_V2
```

then explicitly re-encrypt/migrate active records before retiring `v1`.

The CI acceptance environment also keeps `ETLAYER_DESTINATION_SECRET_KEY_V1` stable across runs. Dynamic projects are disposable, but the Worker encryption root is not treated as an acceptance credential. Rotating the same key version across Cloudflare edge/queue propagation can make newly written ciphertext temporarily or permanently unreadable by another active Worker version. Future rotation must introduce a new key version and migrate deliberately.

## Management API

VS11 adds:

```text
PUT  /_mgmt/projects/:projectId/destinations/:destination/credential
GET  /_mgmt/projects/:projectId/destinations/:destination/credential
POST /_mgmt/projects/:projectId/destinations/:destination/credential/disable
POST /_mgmt/projects/:projectId/destinations/:destination/credential/bootstrap-runtime-default
```

### Write / rotate

Authentication:

```text
Bearer <project operator credential>
```

Request:

```json
{
  "secret": "<provider credential>"
}
```

The plaintext exists only in request processing memory and is encrypted before R2 persistence.

The response returns metadata only:

```json
{
  "credential": {
    "configured": true,
    "projectId": "customer-a",
    "destination": "posthog",
    "status": "active",
    "credentialId": "...",
    "keyVersion": "v1",
    "algorithm": "AES-256-GCM",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

The response never includes plaintext, IV, or ciphertext.

Writing again creates a new encrypted version and advances the current pointer.

### Status

```text
GET .../credential
```

uses project-operator authentication and returns redacted metadata only.

It never returns:

```text
secret
ciphertext
iv
master key
```

### Disable

```text
POST .../credential/disable
```

changes only the current pointer status to `disabled`.

Historical encrypted versions remain intact.

A disabled destination credential resolves as not configured and is never decrypted for delivery.

## Runtime-default bootstrap

```text
POST .../credential/bootstrap-runtime-default
```

is protected by the global `ETLAYER_MANAGEMENT_KEY`, not by the project operator credential.

It exists for controlled migration and acceptance testing.

For PostHog it reads the existing Worker secret:

```text
POSTHOG_PROJECT_TOKEN
```

For Statsig:

```text
STATSIG_SERVER_SECRET
```

The endpoint encrypts that value into the target dynamic project's credential store and returns only metadata.

It never returns the Worker secret.

Project operators cannot call this bootstrap operation.

## Delivery resolution

The destination router resolves credentials before invoking a known adapter.

### Static project

```text
etlayer-default / etlayer-secondary
  -> Worker secret
  -> adapter
```

### Dynamic project

```text
registry project
  -> current destination credential pointer
  -> encrypted version
  -> AES-GCM decrypt
  -> explicit adapter credential
```

For dynamic projects, the adapter receives an explicit credential option.

That explicit option suppresses the adapter's legacy Worker-secret fallback.

Therefore:

```text
dynamic project with no active PostHog credential
  + POSTHOG_PROJECT_TOKEN exists on Worker
  -> posthog_not_configured
  -> global token is NOT used
```

This is a security boundary, not merely configuration precedence.

## Replay

Replay uses the same project credential resolver as normal delivery.

Therefore historical replay cannot accidentally route a dynamic project's events with ETLayer's Worker-global provider credential.

A dynamic replay without an active project credential fails rather than silently using the global token.

## Static compatibility

Static reference projects remain unchanged:

```text
etlayer-default
  PostHog -> POSTHOG_PROJECT_TOKEN
  Statsig -> STATSIG_SERVER_SECRET

etlayer-secondary
  PostHog -> POSTHOG_PROJECT_TOKEN
```

VS11 credential write APIs reject static projects so the two configuration models cannot be accidentally mixed.

## Security properties

VS11 explicitly proves:

- plaintext provider credentials are not stored in R2;
- credential status APIs are write-only/read-metadata-only from a secret perspective;
- the same plaintext encrypted in different projects produces different ciphertext and IV;
- ciphertext transplantation across projects fails AES-GCM authentication;
- project B operator cannot write project A credential;
- project operators cannot bootstrap Worker-global destination secrets;
- dynamic projects never fall back to Worker-global provider secrets;
- provider credential rotation preserves historical ciphertext while changing the active pointer;
- disabling the active pointer immediately stops destination authentication.

## Live acceptance

The isolated Cloudflare suite becomes:

```bash
./scripts/once/vs8-project-isolation.sh
./scripts/once/vs9-dynamic-management.sh
./scripts/once/vs10-first-external-onboarding.sh
./scripts/once/vs11-project-destination-credentials.sh
```

VS9 and VS10 acceptance helpers now create an ephemeral destination master key and bootstrap the CI PostHog Worker secret into their dynamic project before sending events.

VS11 acceptance:

1. rotates ephemeral management and destination-master credentials;
2. deploys the current Worker;
3. creates project A and project B;
4. enables PostHog in both projects;
5. writes the same known canary plaintext into both project credential stores;
6. reads exact encrypted registry evidence using the global management diagnostic path;
7. proves the plaintext canary is absent;
8. proves ciphertext differs between the two projects;
9. proves IV differs between the two projects;
10. bootstraps the real CI PostHog token into encrypted storage for both projects;
11. creates backend producers;
12. proves project A and B both export events;
13. rotates project A's destination credential using the same underlying runtime token;
14. proves the credential id and ciphertext changed;
15. proves project A still exports after rotation;
16. disables project B's destination credential;
17. proves project B's next event remains valid/route-eligible but PostHog delivery is skipped with `posthog_not_configured`;
18. independently checks provider-side PostHog rows for exported event IDs and absence for the disabled project event.

## Non-goals

- general-purpose secret management;
- exposing ciphertext to project operators;
- Cloudflare KMS / external KMS integration;
- automatic master-key re-encryption;
- deleting historical encrypted credential versions;
- custom per-project PostHog/Statsig hosts;
- destination OAuth flows;
- secret expiry scheduling.

## Acceptance status

### VS11.1 - Encrypted project credential core - complete

- append-only encrypted versions implemented;
- active/disabled pointer implemented;
- AES-256-GCM encryption implemented;
- project/destination AAD binding implemented;
- operator write/rotate implemented;
- redacted status read implemented;
- disable implemented;
- global-management runtime bootstrap implemented;
- normal delivery project credential resolution implemented;
- replay project credential resolution implemented;
- static compatibility retained;
- dynamic global-token fallback blocked;
- unit tests cover encryption, rotation, disable, isolation, transplant resistance, routing, and replay.

### VS11.2 - Live acceptance - complete

GitHub Actions `Live Acceptance #45` passed on 2026-09-23 against the isolated Cloudflare `ci` environment and executed VS8, VS9, VS10, and VS11 serially.

VS11 live run:

```text
correlationId:
  vs11-20260923-115948-ea597e2c

project A:
  vs11-20260923-115948-ea597e2c-a

project B:
  vs11-20260923-115948-ea597e2c-b
```

Event IDs:

```text
project A initial:
  98a0e386-4780-4359-9c6f-8a9c9b996b70

project B initial:
  fcf3fead-c987-483a-92b9-cbe32ad30c92

project A after destination credential rotation:
  df85d5d4-e1da-41da-8417-09983afb54c0

project B after destination credential disable:
  2b7b0643-b737-4403-9dbb-c98e467c839a
```

The automated Cloudflare acceptance proved:

```text
samePlaintextDifferentCiphertext = true
samePlaintextDifferentIv         = true
plaintextCanaryAbsentFromRegistry = true
projectARuntimeCredentialRotated = true

project A initial delivery       = exported
project B initial delivery       = exported
project A rotated delivery       = exported

project B disabled delivery      = skipped
project B disabled reason        = posthog_not_configured
```

The canary test deliberately wrote the **same known plaintext secret** into project A and project B, then read the exact encrypted registry records through the global management diagnostic operation.

The plaintext literal was absent from both records, while both the random IV and resulting ciphertext differed.

The helper then replaced the canary with the real CI PostHog token through the global-management-only runtime bootstrap. That token was never returned to the acceptance process.

Project A was subsequently rotated again using the same underlying runtime provider token. The new encrypted credential version became active and a new event still exported successfully.

Project B's active credential pointer was then disabled. Its next event remained:

```text
validation = valid
authority = allowed
routeEligible = true
```

but PostHog delivery was durably:

```text
status = skipped
reason = posthog_not_configured
```

Independent provider-side SQL verification in ETLayer PostHog EU Project `117513` returned:

```text
98a0e386-4780-4359-9c6f-8a9c9b996b70
  project = vs11-20260923-115948-ea597e2c-a
  rows    = 1

fcf3fead-c987-483a-92b9-cbe32ad30c92
  project = vs11-20260923-115948-ea597e2c-b
  rows    = 1

df85d5d4-e1da-41da-8417-09983afb54c0
  project = vs11-20260923-115948-ea597e2c-a
  rows    = 1

2b7b0643-b737-4403-9dbb-c98e467c839a
  rows    = 0
```

Thus the final provider evidence matches ETLayer's durable delivery state: each active project credential delivered only within its trusted project identity, rotation preserved delivery, and disabling project B's destination credential prevented provider delivery even though the Worker-global PostHog token still existed.

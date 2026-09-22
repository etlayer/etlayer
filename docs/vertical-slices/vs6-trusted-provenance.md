# VS6: Trusted provenance and authority

**Status: VS6 complete; live trusted-authority acceptance passed on 2026-09-22.**

## Goal

Make producer provenance a trusted property of the ETLayer ingest boundary rather than a producer-controlled event attribute.

VS6 proves:

```text
producer != actor != subject != authority
```

and, specifically:

> a producer can describe an assertion, but it cannot raise its own trust level.

## Trusted ingest profiles

The Cloudflare reference runtime uses three explicit bearer profiles:

```text
browser
  trusted producer.kind = browser
  allowed authority     = interaction

backend
  trusted producer.kind = backend
  allowed authority     = business_state

agent-runtime
  trusted producer.kind = agent_runtime
  allowed authority     = agent_runtime
```

These profiles are a vertical-slice mechanism, not the final credential-management architecture.

No credential registry, database, OAuth server, or tenant RBAC UI is introduced.

## Trusted provenance envelope

After successful authentication and before Queue enqueue, ETLayer stamps a top-level trusted envelope:

```json
{
  "provenance": {
    "version": 1,
    "profileId": "agent-runtime",
    "authentication": "bearer_profile",
    "producer": {
      "kind": "agent_runtime"
    },
    "allowedAuthorityKinds": [
      "agent_runtime"
    ]
  }
}
```

The envelope is constructed by ETLayer.

It is not decoded from OTLP attributes.

No bearer token, credential value, token hash, or secret-derived identifier is persisted.

## Producer assertions

Existing attributes remain producer assertions:

```text
etlayer.producer.kind
etlayer.authority.kind
```

VS6 does not treat those attributes as trusted merely because a contract requires them.

Instead:

```text
payload assertion
       +
trusted provenance
       |
       v
authority decision
```

## Authority decision

ETLayer records:

```text
authority/<event-id>.json
```

Possible states:

- `allowed`
- `blocked`
- `not_applicable`

Example blocked evidence:

```json
{
  "version": 1,
  "eventId": "event-id",
  "eventName": "account.created",
  "status": "blocked",
  "profileId": "agent-runtime",
  "trustedProducerKind": "agent_runtime",
  "claim": {
    "producerKind": "backend",
    "authorityKind": "business_state"
  },
  "errors": [
    {
      "code": "producer_kind_mismatch",
      "claimed": "backend",
      "trusted": "agent_runtime"
    },
    {
      "code": "authority_not_allowed",
      "authorityKind": "business_state"
    }
  ]
}
```

## Processing order

```text
authenticate ingest
  |
stamp trusted provenance
  |
ingest privacy
  |
Queue
  |
canonical R2
  |
contract validation
  |
authority validation
  |
delivery privacy
  |
identity / actor / delegation
  |
route only when contract and authority both allow
```

Canonical storage therefore preserves the original trusted provenance even for a later-blocked event.

## Agent authority correction

VS5 originally used backend/business-state labels for agent tool events.

VS6 corrects that semantic shortcut.

```text
agent.tool.call@1
agent.subagent.tool.call@1

etlayer.producer.kind  = agent_runtime
etlayer.authority.kind = agent_runtime
```

Meaning:

> an authenticated agent runtime is authoritative for the telemetry fact that the runtime/tool action occurred.

It is **not** automatically authoritative for the downstream business outcome caused by that action.

For example:

```text
agent.tool.call
   |
   v causation
account.created
```

may legitimately have:

```text
agent.tool.call
  provenance = agent_runtime
  authority  = agent_runtime

account.created
  provenance = backend
  authority  = business_state
```

## Acceptance

1. Browser credential authenticates as trusted `browser`.
2. Backend credential authenticates as trusted `backend`.
3. Agent credential authenticates as trusted `agent_runtime`.
4. No credential secret appears in Queue/R2/authority evidence.
5. Browser `landing.hero.exposed@1` + interaction claim is allowed.
6. Backend `account.created@1` + business_state claim is allowed.
7. Agent `agent.tool.call@1` + agent_runtime claim is allowed.
8. Agent subagent event is allowed with the same trusted agent-runtime profile.
9. Browser credential sends a structurally valid `account.created@1` claiming backend/business_state.
10. That spoof event is canonically preserved with trusted provenance=browser.
11. Its contract may be structurally valid, but authority state is blocked.
12. It never reaches PostHog or Statsig.
13. Agent credential sends a structurally valid `account.created@1` claiming backend/business_state.
14. It is canonically preserved with trusted provenance=agent_runtime.
15. Its authority state is blocked.
16. It never reaches PostHog or Statsig.
17. Revalidation of preserved spoof evidence remains blocked without producer re-emission.
18. Existing ordinary funnel remains green.
19. Existing agent/subagent identity semantics remain green.

## Migration compatibility

The old `ETLAYER_INGEST_KEY` may be recognized as a legacy profile during the slice so non-fixture development traffic does not fail authentication unexpectedly.

Legacy provenance grants no privileged authority.

Versioned events that claim privileged authority through a legacy credential are blocked by authority policy.
## Implementation status

### VS6.1 — Trusted provenance and authority core — complete

- ingest authentication now resolves explicit trusted profiles;
- trusted provenance is stamped by ETLayer before Queue enqueue;
- no secret or credential-derived value is stored in provenance;
- browser/backend/agent-runtime profiles have separate authority scopes;
- durable authority evidence is stored under `authority/<event-id>.json`;
- routing is blocked when contract validation or authority validation is blocked;
- revalidation reuses immutable canonical trusted provenance;
- agent contracts now use `agent_runtime` producer/authority semantics;
- fixture routes browser, backend, and agent events through separate credentials;
- deploy helper rotates all three credentials;
- acceptance endpoint can intentionally send valid backend/business-state claims through browser or agent-runtime credentials;
- `scripts/once/vs6-trusted-authority.sh` is executable and self-checking;
- unit/integration CI is green.

### VS6.2 — Live acceptance — complete

Live acceptance passed on 2026-09-22 against the deployed Cloudflare reference runtime.

Ordinary funnel regression:

```text
correlation.id = acceptance-20260922T111637Z-faa1da61
landing.hero.exposed = faaaa127-d901-4406-abe9-3f57a4631ead
landing.hero.cta_clicked = e373c788-aa4f-45c2-988d-6e320474fc16
account.created = 60444be2-c5d2-4421-ab0a-8145fc3a5eb0
```

Trusted-authority acceptance:

```text
correlation.id = vs6-authority-20260922T111659Z-27839859

ALLOW
browser / interaction
  landing.hero.exposed
  888017bc-1e0d-4560-bb18-51377ec4310f

backend / business_state
  identity.linked
  2d402909-93cb-4af4-b149-8377c1e3797d

backend / business_state
  account.created
  8f56df4c-8faf-44fe-874b-5929f5b0b133

agent-runtime / agent_runtime
  agent.tool.call
  91736c36-de2f-42a8-829c-8c5857bbecfa

agent-runtime / agent_runtime
  agent.subagent.tool.call
  a52c6a8d-8618-4ed9-ae45-4c62d885eec7

BLOCK
browser credential claiming backend / business_state
  account.created
  60e590c8-cae0-489a-a0b9-ff1e565c2da2

agent-runtime credential claiming backend / business_state
  account.created
  8f7f28dd-b31d-4063-bcd8-cf42b88350bb
```

For both spoof events:

- the canonical event was preserved;
- contract validation remained `valid`;
- trusted provenance preserved the authenticated profile instead of trusting the payload claim;
- authority was `blocked` with `producer_kind_mismatch` and `authority_not_allowed`;
- no PostHog delivery state existed;
- no Statsig delivery state existed;
- no credential material was persisted.

The acceptance helper verifies destination suppression at ETLayer's durable dispatch boundary by asserting that neither `deliveries/posthog/<event-id>.json` nor `deliveries/statsig/<event-id>.json` exists for either blocked spoof.

Canonical revalidation of the preserved browser spoof returned:

```text
validation = valid
authority  = blocked
deliveries = []
```

The revalidated event retained:

```text
profileId           = browser
trustedProducerKind = browser
claimed producer    = backend
claimed authority   = business_state
```

This proves the VS6 invariant:

> producer payload claims can describe an assertion, but authenticated provenance controls authority and payloads cannot self-elevate trust.

## Non-goals

- credential registry/database;
- tenant-scoped RBAC;
- OAuth/OIDC;
- signed-event PKI;
- generic policy language;
- remote policy fetching;
- business authorization of the original application side effect;
- agent-framework integration;
- changing VS5 subject/actor/delegation semantics;
- treating ETLayer authority evidence as a substitute for the source system's own access control.

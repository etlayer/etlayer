# VS6: Trusted provenance and authority

**Status: In progress.**

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

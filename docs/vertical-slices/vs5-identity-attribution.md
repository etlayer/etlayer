# VS5: Identity, actor, delegation, and attribution semantics

**Status: VS5.1 anonymous-to-user continuity is live-proven; actor/delegation extension implemented; final agent live acceptance pending.**

## Goal

Define deterministic product identity continuity while preserving the immediate actor and responsibility chain.

ETLayer separates four concepts:

```text
subject     who the product analytics event belongs to
actor       who directly performed the action
delegation  on whose behalf / through which principal chain
attribution where the product journey came from
```

This follows the same core accountability principle used by AuditSpec: an agent acting for a user remains an agent actor and is not rewritten as the user.

## Canonical identity model

Recognized product identity coordinates:

- `actor.anonymous.id`
- `user.id`
- `account.id`
- `session.id`

Recognized explicit actor coordinates:

- `actor.type`
- `actor.id`

Supported actor types:

- `anonymous`
- `user`
- `agent`
- `service`
- `api_key`
- `system`
- `automation`

Actor type is explicit semantics. ID prefixes such as `agent_`, `user_`, or `anon_` are conventions only and MUST NOT be used to infer actor type.

### Analytics subject

ETLayer resolves one analytics subject for destination projection:

```text
user.id
  > actor.anonymous.id
  > explicit non-user actor
  > session.id
  > account.id
  > etlayer:<event-id>
```

The subject is not the immediate actor.

For example:

```text
actor.type = agent
actor.id   = agent_hanna
user.id    = usr_42

subject = user/usr_42
actor   = agent/agent_hanna
```

PostHog and Statsig may therefore remain user-centric while ETLayer preserves accountability.

## Delegation

ETLayer represents an ordered responsibility chain with flattened OTLP attributes:

```text
delegation.0.relationship
delegation.0.principal.type
delegation.0.principal.id

delegation.1.relationship
delegation.1.principal.type
delegation.1.principal.id
...
```

Supported relationships:

- `on_behalf_of`
- `delegated_by`
- `impersonation`
- `assumed_role`

Example direct agent:

```text
actor = agent_hanna
delegation.0 = on_behalf_of -> user/usr_42
```

Example subagent:

```text
actor = agent_child
delegation.0 = delegated_by -> agent/agent_parent
delegation.1 = on_behalf_of -> user/usr_42
```

The first delegation entry is nearest to the immediate actor.

## Explicit identity transition

VS5 retains:

```text
identity.linked@1
```

It represents:

```text
anonymous actor/session
        ↓
stable user/account context
```

The event enables destination-specific stitching without producer-side PostHog or Statsig identify calls.

## Agent events

VS5 adds executable contracts for:

```text
agent.tool.call@1
agent.subagent.tool.call@1
```

### agent.tool.call@1

Requires:

- explicit `actor.type=agent`
- explicit `actor.id`
- `user.id`
- `account.id`
- `session.id`
- direct `on_behalf_of -> user` delegation
- `agent.turn.id`
- `agent.tool_call.id`

### agent.subagent.tool.call@1

Requires:

- explicit child-agent actor
- first delegation entry `delegated_by -> agent`
- second delegation entry `on_behalf_of -> user`
- the same user/account/session product context
- agent turn/tool-call correlation

These contracts intentionally preserve the immediate actor rather than flattening it into the user.

## Attribution envelope

VS5 recognizes:

- `attribution.source`
- `attribution.medium`
- `attribution.campaign`

Attribution remains attached to the product journey across anonymous, user, agent, and subagent events.

VS5 does not compute historical first-touch or last-touch attribution.

## Durable identity evidence

Identity semantics are recorded per event:

```text
identity/<event-id>.json
```

Version 2 evidence separates subject and actor:

```json
{
  "version": 2,
  "eventName": "agent.subagent.tool.call",
  "subject": {
    "kind": "user",
    "id": "usr_42"
  },
  "actor": {
    "type": "agent",
    "id": "agent_child",
    "source": "explicit"
  },
  "delegation": [
    {
      "relationship": "delegated_by",
      "principal": {
        "type": "agent",
        "id": "agent_parent"
      }
    },
    {
      "relationship": "on_behalf_of",
      "principal": {
        "type": "user",
        "id": "usr_42"
      }
    }
  ]
}
```

This is per-event semantic evidence, not an identity graph.

## Agent correlation

VS5 records:

- `agent.turn.id`
- `agent.tool_call.id`

These are correlation coordinates, not identity replacements.

## Destination projection

### PostHog

The analytics subject drives `distinct_id`.

Therefore:

```text
agent acting for user
  distinct_id = user.id

properties:
  actor.type = agent
  actor.id   = agent_hanna
  delegation.* preserved
```

For `identity.linked@1`:

```text
event = $identify
distinct_id = user.id
$anon_distinct_id = actor.anonymous.id
```

This keeps anonymous -> identified person stitching while retaining actor properties on agent events.

### Statsig

For identified user journeys:

```text
userID = user.id
```

Known alternate IDs are carried as custom IDs:

```text
anonymousID
sessionID
accountID
agentID
```

An agent actor does not replace the user product subject.

## Privacy interaction

VS4 privacy policy explicitly classifies:

- `actor.type` as operational;
- `actor.id` as pseudonymous identifier;
- delegation principal IDs as pseudonymous identifiers;
- delegation relationships/types as operational;
- agent turn/tool-call IDs as operational.

VS5 therefore does not create a privacy bypass.

## Processing order

```text
canonical R2
   |
contract validation
   |
privacy projection
   |
identity / actor / delegation resolution
   |
durable identity evidence
   |
destination routing
```

Blocked events may still produce semantic evidence but never reach destinations.

## Live proof: anonymous -> user continuity

Correlation:

```text
vs5-identity-20260921T234009Z-56fbd4f5
```

ETLayer recorded:

```text
landing.hero.exposed
  subject = anonymous

identity.linked
  subject = user
  transition = anonymous_to_user

account.created
  subject = same user
```

PostHog independently proved:

```text
hero distinct_id          anon_c313fd49-b762-4483-ae0f-dec5a1c321c9
$identify distinct_id     user_65b17c19-9511-4a51-9e69-9c2e1333f044
$anon_distinct_id         anon_c313fd49-b762-4483-ae0f-dec5a1c321c9
account.created distinct  user_65b17c19-9511-4a51-9e69-9c2e1333f044

PostHog person_id for all three:
e61da9a0-0025-5dee-b98d-3c94b84287d7
```

This proves real anonymous -> identified stitching.

## Implementation status

### VS5.1 — Anonymous/user identity continuity — live proven

- executable `identity.linked@1` contract;
- stable session + attribution;
- canonical subject resolver;
- PostHog `$identify`;
- Statsig user/custom-ID projection;
- live anonymous -> user person stitching proven.

### VS5.2 — Actor and delegation semantics — implemented, live acceptance pending

- explicit `actor.type` + `actor.id`;
- ordered delegation parsing;
- AuditSpec-aligned immediate-actor preservation;
- `agent.tool.call@1` contract;
- `agent.subagent.tool.call@1` contract;
- identity evidence v2 with separate `subject`, `actor`, and `delegation`;
- agent actor projected separately from user analytics subject;
- agent/subagent fixture flow;
- `scripts/once/vs5-agent-delegation.sh` acceptance helper.

## Final acceptance

The remaining live proof is:

```text
user subject
  |
  +-- actor=agent_parent
  |     on_behalf_of -> user
  |
  +-- actor=agent_child
        delegated_by -> agent_parent
        on_behalf_of -> user
```

Expected:

1. both agent events are contract-valid;
2. identity evidence version is 2;
3. both events have `subject.kind=user`;
4. direct event actor remains the parent agent;
5. subagent event actor remains the child agent;
6. ordered delegation is preserved exactly;
7. PostHog `distinct_id` remains the same user for both;
8. PostHog properties preserve both agent actor IDs;
9. Statsig `userID` remains the same user;
10. Statsig carries the current agent as `customIDs.agentID`;
11. all events preserve session/account/attribution continuity;
12. no producer code calls PostHog/Statsig identity APIs.

## Non-goals

- general identity graph;
- cross-device probabilistic matching;
- email or phone identity matching;
- merge/split UI;
- account hierarchy;
- historical first-touch/last-touch computation;
- retroactive canonical event rewrites;
- destination-specific identity calls in producer code.

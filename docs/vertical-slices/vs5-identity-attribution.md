# VS5: Identity continuity and attribution semantics

**Status: In progress.**

## Goal

Define deterministic anonymous-to-user identity continuity and attribution semantics in ETLayer without turning ETLayer into a general identity graph.

The reference lifecycle is:

```text
landing.hero.exposed
  anonymous + session + attribution
          |
          v
identity.linked@1
  anonymous + user + account + same session
          |
          v
account.created
  user + anonymous + account + same session
```

The application emits vendor-neutral identity facts. ETLayer owns normalization and destination projection.

## Canonical identity model

Recognized identifiers:

- `actor.anonymous.id`
- `user.id`
- `account.id`
- `session.id`

Primary subject precedence:

```text
user.id
  > actor.anonymous.id
  > session.id
  > account.id
  > etlayer:<event-id>
```

The primary subject is a projection choice, not destructive normalization. All known IDs remain in the identity envelope.

## Explicit transition event

VS5 adds:

```text
identity.linked@1
```

It is backend-authoritative and requires:

- `actor.anonymous.id`
- `user.id`
- `account.id`
- `session.id`
- `correlation.id`
- `causation.id`
- `etlayer.producer.kind = backend`
- `etlayer.authority.kind = business_state`

Semantics:

> The backend has established that the anonymous actor/session belongs to this stable user and account context.

This is an explicit fact event. It does not create a mutable cross-device identity graph.

## Attribution envelope

VS5 recognizes:

- `attribution.source`
- `attribution.medium`
- `attribution.campaign`

Acceptance keeps the same attribution values on the anonymous event, the identity link, and the subsequent account event.

VS5 deliberately does not compute historical first-touch or last-touch attribution.

## Durable identity evidence

Identity semantics are recorded per event:

```text
identity/<event-id>.json
```

Example:

```json
{
  "version": 1,
  "eventId": "event-id",
  "eventName": "identity.linked",
  "status": "resolved",
  "primary": {
    "kind": "user",
    "id": "user_123"
  },
  "anonymousId": "anon_123",
  "userId": "user_123",
  "accountId": "account_123",
  "sessionId": "session_123",
  "transition": {
    "kind": "anonymous_to_user",
    "from": "anon_123",
    "to": "user_123"
  },
  "attribution": {
    "source": "docs",
    "medium": "acceptance",
    "campaign": "vs5"
  }
}
```

This state is evidence of how ETLayer interpreted one event. It is not a graph or mutable user profile.

## Destination projection

### PostHog

Ordinary events use the canonical primary identity for `distinct_id`.

For `identity.linked@1`, ETLayer projects:

```text
event = $identify
distinct_id = user.id
$anon_distinct_id = actor.anonymous.id
```

The application never calls PostHog `identify()`.

### Statsig

For identified events:

```text
userID = user.id
customIDs.anonymousID = actor.anonymous.id
customIDs.sessionID = session.id
customIDs.accountID = account.id
```

When the user is still anonymous, the anonymous identifier remains the primary fallback while all known IDs continue to be projected.

## Processing order

```text
canonical R2
   |
contract validation
   |
privacy projection
   |
identity resolution + durable identity state
   |
destination routing
```

A blocked event may still produce semantic evidence, but it never reaches destinations.

## Acceptance

1. Add executable `identity.linked@1` contract.
2. Add one shared identity resolver.
3. Record `identity/<event-id>.json`.
4. Give the acceptance browser a stable `session.id`.
5. Preserve attribution across anonymous -> identified transition.
6. Anonymous hero event resolves primary identity to the anonymous actor.
7. Identity link resolves primary identity to `user.id`.
8. Subsequent account event resolves primary identity to the same `user.id`.
9. PostHog anonymous event uses anonymous distinct ID.
10. PostHog identity link is stored as `$identify` with `$anon_distinct_id`.
11. PostHog subsequent account event uses `user.id`.
12. Statsig identified events use `userID=user.id` plus anonymous/session/account custom IDs.
13. Attribution values are identical across the acceptance lifecycle.
14. Revalidation and replay use the same identity resolver.
15. Existing three-event funnel remains unchanged.

## Non-goals

- general identity graph;
- cross-device probabilistic matching;
- email or phone matching;
- merge/split UI;
- account hierarchy;
- historical first-touch/last-touch computation;
- retroactive canonical event rewrites;
- destination-specific identity calls in producer code.

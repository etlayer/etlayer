# VS14: First-class Quarantine

**Status: implementation in progress.**

Tracks GitHub issue #48.

Classification:

~~~text
A1-NOW-GOV/OPS
Core - small effort - do now
Governance + Operations / Reliability / Observability
~~~

## Risk

ETLayer already preserves canonical event evidence before destination routing, but contract/data-quality failures and semantic trust violations have historically converged on the same blocked routing shape.

That loses an important distinction:

~~~text
recoverable bad/incompatible data
!=
unauthorized assertion of a business fact
~~~

An operator must be able to tell whether an event can become usable after a contract/data correction or whether the producer fundamentally lacked authority to assert the fact.

## Target invariant

~~~text
authority denied
  -> BLOCK

contract/data-quality failure
  -> QUARANTINE

otherwise
  -> ALLOW
~~~

When multiple conditions exist, the stronger trust outcome wins:

~~~text
BLOCK > QUARANTINE > ALLOW
~~~

Routing occurs only for ALLOW.

## Smallest useful slice

VS14 deliberately reuses the existing durable pipeline.

It does not add a quarantine queue, database, or new storage subsystem.

Existing primitives already provide:

- durable project-scoped R2 event preservation;
- validation evidence;
- authority evidence;
- privacy evidence;
- identity evidence;
- append-only decision lineage;
- public event inspection;
- revalidation without producer re-emission.

VS14 adds the missing semantics:

~~~text
validation.status:
  valid
  quarantined
  unmanaged

decision.outcome:
  allow
  quarantine
  block
~~~

Historical blocked validation evidence remains readable for compatibility, but new contract validation failures are written as quarantined.

## Decision precedence

~~~text
if authority.status == blocked
  outcome = block

else if validation.status == quarantined
  outcome = quarantine

else
  outcome = allow
~~~

Legacy validation status blocked maps to quarantine when producing a new decision so older/custom validation evidence cannot accidentally become route eligible.

## Storage semantics

A quarantined event is still durably preserved as ETLayer evidence.

VS14 does not redefine a quarantined claim as a trusted business fact. The durable object is preserved evidence that can be inspected and re-evaluated.

The original event object remains immutable.

Revalidation appends a new decision record and advances only the latest-decision pointer.

## Public/operator semantics

Existing event inspection surfaces expose the new decision outcome.

Examples:

~~~text
validation.status = quarantined
authority.status  = allowed
decision.outcome  = quarantine
routeEligible     = false
delivery          = not_routed
~~~

and:

~~~text
validation.status = valid
authority.status  = blocked
decision.outcome  = block
routeEligible     = false
delivery          = not_routed
~~~

No new public endpoint is required for this slice.

## Executable acceptance

The live Cloudflare acceptance must prove three independent outcomes using one authenticated backend producer.

### A - ALLOW

~~~text
backend credential
  -> account.created@1
  -> required account.id present
  -> validation valid
  -> authority allowed
  -> decision ALLOW
  -> PostHog exported
~~~

### B - QUARANTINE

~~~text
backend credential
  -> account.created@1
  -> account.id missing
  -> validation quarantined
  -> authority allowed
  -> decision QUARANTINE
  -> no destination delivery
~~~

Then revalidate the exact preserved source without producer re-emission:

~~~text
same source
  -> validation quarantined
  -> authority allowed
  -> new decision QUARANTINE
  -> no destination delivery
~~~

### C - BLOCK

Use the same trusted backend credential while the payload claims a browser interaction event:

~~~text
trusted producer = backend
payload claim    = browser / interaction

landing.hero.exposed@1
  -> contract valid
  -> authority blocked
  -> decision BLOCK
  -> no destination delivery
~~~

This isolates semantic authority from contract validity.

## Non-goals

VS14 does not include:

- correction/edit UI;
- a separate quarantine queue;
- automatic contract inference;
- contract lifecycle or publishing;
- compatibility checking;
- bulk quarantine search;
- quarantine retention policy;
- operator notifications;
- a new storage engine.

Those can build on the semantic primitive after it is live-proven.

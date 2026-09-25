# VS18: First-class Delivery and Append-only Attempts

**Status: implementation in progress.**

Tracks GitHub issue #56.

Classification:

~~~text
A2-NOW-OPS/UX
Core - medium effort - do now
Operations / Reliability / Observability + User Experience
~~~

## Risk

Before VS18, ETLayer stores one mutable delivery summary per event × destination.

A later retry or revalidation can overwrite the previous result. Operators cannot reliably answer:

- how many destination invocations happened;
- what happened on each invocation;
- whether a failure or not-configured state preceded success;
- which replay or revalidation created an export;
- whether an idempotency short-circuit actually invoked the destination.

That makes a future Event Inspector incomplete and weakens delivery debugging.

## Target invariant

~~~text
event × destination
  = one stable logical Delivery

every destination invocation
  = one immutable Attempt

Delivery
  -> current summary / idempotency gate

Attempt
  -> append-only historical evidence
~~~

An `already_exported` short-circuit does not create an Attempt because the destination exporter is not invoked.

## Storage

Logical Delivery summary remains at the established mutable key:

~~~text
projects/<project>/deliveries/<destination>/<event>.json
~~~

VS18 promotes the summary to version 3 and adds:

~~~text
deliveryId
attemptCount
latestAttemptId
latestAttemptNumber
lastAttemptAt
~~~

Attempts are separate append-only objects:

~~~text
projects/<project>/delivery-attempts/<destination>/<event>/<number>--<attempt-id>.json
~~~

An Attempt contains:

~~~text
version
projectId
deliveryId
attemptId
attemptNumber
eventId
eventName
destination
mode
status
startedAt
completedAt
reason?
destinationEventId?
error?
replayId?
sourceKey?
~~~

## Stable Delivery identity

The logical delivery identity is deterministic for:

~~~text
projectId × eventId × destination
~~~

Retries, replay, and revalidation do not change `deliveryId`.

## Attempt modes

Current modes:

~~~text
live
replay
revalidation
~~~

The mode describes why a destination invocation occurred. It does not create a new business event.

## Historical compatibility

Historical v1/v2 delivery summaries remain readable.

If a historical summary exists without `attemptCount`, VS18 treats it as one pre-VS18 historical attempt for numbering purposes:

~~~text
historical summary exists
no append-only Attempt objects
next real Attempt number = 2
~~~

ETLayer does not synthesize a fake immutable Attempt object for history it never recorded.

## Internal inspection

The internal operator inspection surface includes both:

~~~text
Delivery summary
Attempt history
~~~

This allows an Event Inspector to reconstruct delivery history without reading R2 coordinates directly.

## Public status boundary

The public event-status API continues to expose delivery status but does not automatically expose the internal Attempt history.

Attempt IDs, errors, modes, and historical records remain an operator/internal concern in VS18.

## Replay and revalidation

Replay records a real Attempt when the destination exporter is invoked.

Revalidation records a real Attempt when a newly eligible or newly configured event is routed again.

If the Delivery summary is already `exported`, routing returns:

~~~text
status: skipped
reason: already_exported
~~~

without invoking the exporter and therefore without creating another Attempt.

## Executable acceptance

In isolated Cloudflare CI:

1. create an isolated project;
2. enable PostHog without a project destination credential;
3. create a backend producer;
4. emit a valid event;
5. prove Delivery is skipped/not-configured;
6. prove immutable Attempt #1 is skipped/not-configured in `live` mode;
7. record stable `deliveryId`, Attempt #1 ID, and canonical source key;
8. bootstrap the real CI PostHog credential into the project;
9. revalidate the preserved event;
10. prove Attempt #2 is exported in `revalidation` mode;
11. prove `deliveryId` is unchanged;
12. prove Attempt #1 remains intact;
13. prove Delivery v3 advances to `attemptCount=2` and points to Attempt #2;
14. revalidate again after exported state;
15. prove routing returns `already_exported`;
16. prove no Attempt #3 exists;
17. prove internal inspect shows exactly two Attempts;
18. prove public event status does not expose Attempt history;
19. keep prior live acceptance slices green.

## Non-goals

VS18 does not add:

- an automatic retry scheduler;
- destination pause/resume;
- rate limiting;
- a dead-letter queue;
- a new queue topology;
- a hosted dashboard;
- public Attempt-history APIs;
- generalized workflow orchestration.

Those can build on the Delivery/Attempt primitive when needed.

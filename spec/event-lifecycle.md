# Event Lifecycle

## States

A logical event moves through a small number of lifecycle stages:

```text
produced
   |
received
   |
accepted
   |
persisted
   |
projected
   |
exported
```

Failures may occur between stages and must not be confused with a new logical event.

## Produced

The producer creates the event and assigns the semantic event name, business attributes, occurrence time, and any available trace or identity context.

## Received

The gateway receives an OTLP request.

Receipt alone does not mean the event has passed validation or been accepted.

## Accepted

The gateway has authenticated the request, decoded the supported OTLP representation, and accepted the event for processing.

Accepted events should receive or preserve a stable logical event identity.

## Persisted

A replayable representation exists in durable storage.

For VS1, persistence is the recovery boundary before ETLayer considers downstream delivery recoverable.

## Projected

An exporter maps the ETLayer-managed event to a destination-specific representation.

Projection may intentionally omit fields unsupported or unnecessary for that destination.

Projection must not mutate the durable source event.

## Exported

The destination has acknowledged the projected event according to the exporter's delivery contract.

An export acknowledgement does not delete the canonical event.

## Failure and retry

ETLayer assumes transient failures.

A retry of the same logical event must preserve its event identity.

Internal delivery may be at-least-once. Therefore all processing stages should be designed to tolerate duplicates.

## Replay

Replay creates a new delivery attempt for an existing accepted event.

Replay does not create a new business event.

The replay operation should record operational metadata separately from the event's original occurrence time and identity.

## Immutability

The original accepted event should be treated as immutable.

Corrections should be represented as:

- a new event;
- a versioned transformation during projection;
- or explicit administrative metadata.

Silent mutation makes deterministic replay impossible.

## Time

At minimum distinguish:

- occurrence time - when the producer says the domain event happened;
- receive time - when ETLayer observed it;
- export time - when a destination delivery occurred.

These timestamps answer different questions and should not be collapsed.

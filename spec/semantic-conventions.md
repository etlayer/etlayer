# Semantic Conventions

## Strategy

Use upstream OpenTelemetry semantic conventions whenever a suitable stable or adopted convention exists.

ETLayer defines only the product/business semantics that are missing or require ETLayer-specific lifecycle metadata.

Custom attributes use the `etlayer.*` namespace where they describe ETLayer itself.

Domain attributes should use the owning domain namespace rather than `etlayer.*`.

## Event names

Event names should be:

- low-cardinality;
- stable;
- domain-specific;
- written as state or action facts;
- free of user IDs, random IDs, timestamps, or other dynamic values.

Examples:

```text
landing.hero.exposed
landing.hero.cta_clicked
account.created
github_app.installed
review.created
review.completed
```

Avoid:

```text
clicked_button_42
user_123_created_account
posthog_conversion
```

## Initial ETLayer metadata

VS1 may require a minimal set of ETLayer lifecycle attributes:

```text
etlayer.event.id
etlayer.schema.version
```

These names are provisional until the implementation validates the need.

## Experiment context

Until an upstream convention fully covers the required product experiment context, events may carry:

```text
experiment.id
experiment.variant
```

Experiment exposure itself should be an explicit event when analysis requires exposure semantics.

ETLayer does not define statistical meaning for a variant.

## Identity

Identity should be explicit and source-aware.

Potential concepts include:

```text
user.id
session.id
actor.anonymous.id
account.id
```

Where OpenTelemetry defines a suitable convention, prefer it.

VS1 does not attempt full anonymous-to-known identity resolution. It only preserves identifiers supplied by trusted producers and allows exporters to project them.

## Correlation and causation

Trace context should be used when a trace relationship exists.

Product/business causal relationships may additionally require durable domain identifiers such as:

```text
correlation.id
causation.id
```

These are not substitutes for trace/span IDs.

## Schema version

Business events evolve.

A schema version must identify the event contract independently from destination mappings.

Example:

```text
event name: account.created
schema version: 1
```

Changing a PostHog property mapping does not by itself require a business-event schema version change.

## Deprecation rule

When OpenTelemetry introduces an appropriate upstream convention:

1. support the upstream form;
2. provide a migration period if necessary;
3. stop emitting the ETLayer-specific equivalent;
4. retain compatibility in replay/export where practical.

The goal is to shrink ETLayer's custom semantic surface over time, not expand it indefinitely.


## Producer source and authority

OpenTelemetry's generic `source.*` attributes describe network senders, not product-event authority, so VS1 does not reuse them for browser-vs-backend provenance.

Until an upstream convention covers this product-event concept, ETLayer may preserve:

```text
etlayer.producer.kind
etlayer.authority.kind
```

Initial VS1 values:

```text
etlayer.producer.kind = browser | backend
etlayer.authority.kind = interaction | business_state
```

These describe where the product event was produced and what kind of fact that producer is authoritative for. They do not replace trace context, identity, correlation, or causation.

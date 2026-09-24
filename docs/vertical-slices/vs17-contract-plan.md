# VS17: Contract Plan Against Historical Events

**Status: complete and live-proven.**

Tracks GitHub issue #54.

Classification:

~~~text
A2-NOW-GOV/DX
Core - medium effort - do now
Governance + Developer Experience
~~~

## Risk

VS16 can prove that a contract change is formally breaking, but static compatibility cannot answer the operational question:

> What would this change actually do to our real events?

A formally breaking change may affect zero historical events or a large fraction of production traffic. Publishing without that evidence can unexpectedly move trusted traffic into quarantine.

## Target invariant

~~~text
proposed contract
  + immutable historical project events
  =
read-only decision impact before publication
~~~

Planning must not mutate:

- canonical event evidence;
- validation state;
- authority state;
- decision lineage;
- delivery state;
- destination systems.

## Scope

VS17 plans one proposed contract version against one current contract version for one project and one received-at time range.

It reuses:

- project-scoped operator authentication;
- R2 canonical archive;
- replay's deterministic time-range selection;
- VS16 static compatibility;
- contract validation;
- authority evaluation;
- VS14 decision outcome semantics.

It does not revalidate or deliver events.

## Selection

Only preserved events satisfying both conditions are evaluated:

~~~text
event.eventName == requested eventName
etlayer.schema.version == currentVersion
~~~

Filtering happens before maxEvents accounting so unrelated project traffic cannot consume the plan limit.

## Transition model

For every selected event ETLayer evaluates:

~~~text
same preserved event
  |
  +-- current contract  -> current validation
  |
  +-- proposed contract -> proposed validation
  |
  +-- same authority evidence/semantics
  |
  v
current outcome -> proposed outcome
~~~

Examples:

~~~text
allow      -> allow
allow      -> quarantine
quarantine -> allow
quarantine -> quarantine
block      -> block
~~~

A contract-only plan cannot override authority. An authority-blocked event therefore remains BLOCK even if its contract result changes.

## Result

The response contains:

- selected event count;
- changed event count;
- transition counts;
- VS16 compatibility result;
- bounded changed-event examples;
- sourceKey coordinates for operator diagnosis;
- current/proposed validation summaries.

No plan result is persisted in VS17.

## Operator API

~~~text
POST /_ops/plan/contract
Authorization: Bearer <project-operator>
Content-Type: application/json
~~~

Input includes:

~~~json
{
  "projectId": "customer-a",
  "eventName": "account.created",
  "currentVersion": 1,
  "proposedContract": {},
  "from": "2026-09-24T10:00:00Z",
  "to": "2026-09-24T11:00:00Z",
  "compatibilityMode": "backward",
  "maxEvents": 500,
  "maxExamples": 25
}
~~~

## Executable acceptance

The Cloudflare acceptance creates an isolated project with no destinations and preserves three account.created@1 events:

~~~text
A
current:  ALLOW
proposed: ALLOW
has plan.id

B
current:  ALLOW
proposed: QUARANTINE
missing plan.id

C
current:  QUARANTINE
proposed: QUARANTINE
missing account.id
has plan.id
~~~

The proposed account.created@2 adds required plan.id.

Expected plan:

~~~text
selected 3
changed  1

allow_to_allow                 1
allow_to_quarantine            1
quarantine_to_quarantine       1

static backward compatibility:
breaking
required_attribute_added: plan.id
~~~

The acceptance inspects event B before and after planning and proves:

~~~text
decisionId before == decisionId after
deliveries before == []
deliveries after  == []
~~~

This is the executable read-only proof.

## Non-goals

VS17 does not include:

- contract persistence;
- draft/review/publish lifecycle;
- environment promotion;
- policy planning beyond contracts;
- audit persistence for plan reads;
- impact graph/consumers;
- asynchronous large-range jobs;
- ClickHouse acceleration;
- dashboard visualization.

Those can build on the planning primitive.


---

# Completion evidence

VS17 completed with:

~~~text
PR CI                       green
Live Acceptance #98 attempt 2 green
runtime head                4eb978e8152db8de1638ad156abe6eebb6c867d8
~~~

The first Live Acceptance attempt failed transiently in the already-proven VS13 Cloudflare ingest path with Worker 1101 before VS17 executed. The same immutable SHA was re-run without code changes and passed the full suite.

Final VS17 live correlation:

~~~text
vs17-20260924-142236-6fe8dfa5
~~~

Project:

~~~text
vs17-20260924-142236-6fe8dfa5
~~~

Observed plan:

~~~text
selected 3
changed  1

allow_to_allow                 1
allow_to_quarantine            1
quarantine_to_quarantine       1
~~~

Read-only proof:

~~~text
decisionId before
b2aa5ef7-6323-47d7-8a27-22900a8a3e5d

decisionId after
b2aa5ef7-6323-47d7-8a27-22900a8a3e5d

decision lineage mutated       false
destination delivery triggered false
~~~

Therefore ETLayer can now evaluate a proposed contract against real preserved project history before publication without changing runtime truth.

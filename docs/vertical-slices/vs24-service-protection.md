# VS24: Service Protection Baseline

**Status: complete and live-proven.**

Tracks GitHub issue #87.

Classification:

~~~text
A1-NOW-SEC/OPS
Core - medium effort - do now
Security + Operations
~~~

## Risk

The trust/governance core is live-proven through VS23, but public ingest must also defend shared hosted-service resources.

Before VS24, ETLayer already enforced a request-byte ceiling but had no project-scoped request-rate boundary and no explicit event-count ceiling.

## Target invariant

~~~text
authenticated ingest request
  -> trusted projectId
  -> project-scoped rate limit
  -> bounded request bytes
  -> bounded event count
  -> Queue

one noisy project
  !=
another project's rate budget
~~~

Rejected requests must not enqueue events.

## Existing byte bound

ETLayer already supports:

~~~text
ETLAYER_MAX_REQUEST_BYTES
~~~

Production default:

~~~text
1 MiB
~~~

VS24 keeps both declared Content-Length and actual UTF-8 request-body checks.

Failure:

~~~text
HTTP 413
OTLP code 8
request body exceeds ingest limit
~~~

## Event-count bound

VS24 adds:

~~~text
ETLAYER_MAX_EVENTS_PER_REQUEST
~~~

Production default:

~~~text
1000
~~~

The event count is checked after OTLP JSON normalization and before privacy processing or Queue writes.

Failure:

~~~text
HTTP 413
OTLP code 8
request contains too many events
~~~

## Project-scoped request rate limit

VS24 uses the Cloudflare Workers Rate Limiting binding:

~~~text
ETLAYER_INGEST_RATE_LIMITER
~~~

Production configuration:

~~~text
600 requests / 60 seconds
~~~

The limiter key is:

~~~text
trusted provenance projectId
~~~

It is not derived from:

- payload project claims;
- IP address;
- user-agent;
- event contents.

The limiter is invoked only after ingest authentication succeeds.

Invalid credentials therefore do not consume a trusted project's rate-limit key.

## Rate-limit semantics

Cloudflare's native Worker Rate Limiting API is intentionally permissive and eventually consistent.

ETLayer therefore treats it as an abuse/service-protection boundary, not accounting or billing truth.

Failure:

~~~text
HTTP 429
OTLP code 8
ingest rate limit exceeded
Retry-After: <configured period>
~~~

VS24 does not promise that the exact N+1 request is the first request rejected.

It promises bounded eventual enforcement for the same trusted project key.

## CI configuration

The isolated CI Worker intentionally uses smaller bounds so the live proof is cheap and deterministic enough to exercise the behavior:

~~~text
max request bytes       65536
max events/request      5
rate limit              20 requests / 10 seconds
~~~

Production remains:

~~~text
max request bytes       1048576
max events/request      1000
rate limit              600 requests / 60 seconds
~~~

Production and CI use different rate-limit namespaces so acceptance traffic does not consume production budget.

## Queue safety

All three service-protection checks occur before Queue writes:

~~~text
rate limit
request bytes
event count
~~~

Therefore a rejected request does not create canonical or downstream evidence.

## Executable acceptance

The fast VS24 Cloudflare acceptance:

1. rotates the CI management credential and deploys the current Worker;
2. creates isolated project A and project B;
3. creates one backend producer in each;
4. proves both projects can ingest a normal event and reach complete processing;
5. sends repeated invalid credentials and proves they remain 401;
6. proves project B can still ingest after invalid-auth traffic;
7. drives project A until a 429 is observed;
8. proves the 429 is OTLP resource-exhausted and carries Retry-After=10;
9. immediately proves project B can still ingest;
10. sends an oversized body and proves HTTP 413;
11. sends six events against the CI max of five and proves HTTP 413;
12. inspects the event IDs from each rejected request and proves no event evidence exists.

After merge, full regression extends to VS8 -> VS24.

## Non-goals

VS24 does not add:

- billing quotas;
- exact request accounting;
- per-user limits;
- IP-based rate limiting;
- WAF configuration;
- workspace plans/tiers;
- Queue backlog admission control;
- storage quotas;
- destination-call rate limiting;
- UI;
- alerting.

These should be introduced only when a concrete hosted-product requirement needs them.


---

# Completion evidence

VS24 completed with:

~~~text
implementation PR              #88
merged main commit             9c58cbffe9dc31d917df6a71be797fb5493fc313
PR CI                          green
fast slice live acceptance     green
slice acceptance run           #36251702324
post-merge main CI             green
post-merge CI run              #36251828194
full VS8 -> VS24 regression    green
full regression run            #36251828240
~~~

The first fast live attempt used sequential requests and did not cross the Cloudflare Rate Limiting binding's effective burst threshold.

The acceptance was corrected to drive the same trusted project key with bounded concurrent burst traffic. This tests the actual Cloudflare limiter semantics rather than assuming an exact sequential N+1 boundary.

Fast live proof:

~~~text
correlationId
vs24-20260926-152237-9c5743cb

projectA
vs24-20260926-152237-9c5743cb-a

projectB
vs24-20260926-152237-9c5743cb-b

rateLimitedEventId
d8f3f35a-88e3-43cd-86cb-634d6ae829e2

rateLimitedAttempt
160

retryAfterSeconds
10
~~~

Observed service-protection proof:

~~~text
projectIsolation                         true
oversizedBodyRejected                    true
tooManyEventsRejected                    true
invalidCredentialsConsumedProjectBudget  false
rejectedEventEvidenceCreated             false
~~~

The post-merge full regression re-proved the accumulated Cloudflare runtime sequence through VS24 on main.

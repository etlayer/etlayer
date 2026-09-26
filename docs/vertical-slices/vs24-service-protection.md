# VS24: Service Protection Baseline

**Status: implementation in progress.**

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

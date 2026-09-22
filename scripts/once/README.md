# Once / acceptance helpers

These scripts reproduce and diagnose ETLayer's Cloudflare vertical slices.

They are intentionally **not** the long-term ETLayer CLI. Keep them while they remain useful as executable acceptance evidence; replace them with durable provisioning or CLI commands when those interfaces stabilize.

All deployment commands use local Wrangler OAuth. No `CLOUDFLARE_API_TOKEN` is required.

## bootstrap-cloudflare.sh

Bootstraps the ETLayer Cloudflare ingest runtime:

1. verifies Node/npm and Wrangler;
2. verifies local Cloudflare authentication;
3. ensures Queue, DLQ, and R2 resources exist;
4. generates and rotates `ETLAYER_INGEST_KEY`;
5. preserves or securely prompts for `POSTHOG_PROJECT_TOKEN`;
6. deploys `etlayer-ingest`;
7. checks `/health`;
8. sends an OTLP smoke event.

```bash
./scripts/once/bootstrap-cloudflare.sh
```

Statsig is intentionally not bootstrapped by this script. VS2 live activation uses a Statsig Server Secret stored only as the Worker secret `STATSIG_SERVER_SECRET`.

## deploy-fixture.sh

Deploys the browser + backend + agent acceptance fixture, configures the trusted browser/backend/agent-runtime ingest credentials, verifies the ETLayer Service Binding, and runs direct plus fixture-mediated OTLP preflights before printing a funnel URL.

```bash
./scripts/once/deploy-fixture.sh
```

## Destination outage switches

Generic form:

```bash
./scripts/once/export-mode.sh posthog disable
./scripts/once/export-mode.sh posthog enable

./scripts/once/export-mode.sh statsig disable
./scripts/once/export-mode.sh statsig enable
```

Compatibility/convenience wrappers:

```bash
./scripts/once/posthog-export-mode.sh disable
./scripts/once/posthog-export-mode.sh enable

./scripts/once/statsig-export-mode.sh disable
./scripts/once/statsig-export-mode.sh enable
```

Disabling one projection does not disable canonical R2 persistence or the other destination.

Do not leave a destination disabled after an acceptance run.

## Destination-aware replay

Generic form:

```bash
./scripts/once/replay-destination.sh \
  --destination statsig \
  --from 2026-09-22T10:00:00Z \
  --to   2026-09-22T10:05:00Z
```

Convenience wrappers preserve the VS1 PostHog command and add the VS2 Statsig equivalent:

```bash
./scripts/once/replay-posthog.sh \
  --from 2026-09-21T20:34:03Z \
  --to   2026-09-21T20:35:05Z

./scripts/once/replay-statsig.sh \
  --from 2026-09-22T10:00:00Z \
  --to   2026-09-22T10:05:00Z
```

Only the named destination is invoked by a replay.

## diagnose-smoke.sh

Low-level diagnostic helper for Queue, R2, Worker logs, and destination projection when the normal smoke path fails.

## Secret handling

These helpers never write secret values into the repository or an `.env` file. Generated ingest/replay keys are passed directly to Wrangler secrets and kept only in process memory.

Runtime destination secrets:

```text
POSTHOG_PROJECT_TOKEN
STATSIG_SERVER_SECRET
```


## VS3 invalid-event contract acceptance

After deploying the current ETLayer Worker and fixture, this helper emits one intentionally invalid versioned business event:

```text
account.created@1
missing: account.id
```

Run:

```bash
./scripts/once/vs3-invalid-account.sh
```

The helper verifies:

- the event was accepted by OTLP ingest;
- the canonical event exists in R2;
- durable validation state is `blocked`;
- the exact error is `required_attribute_missing/account.id`;
- validation state points back to the exact canonical `sourceKey`;
- PostHog delivery state is absent;
- Statsig delivery state is absent;
- the same canonical object can be revalidated through `/_ops/revalidate` without a producer re-emitting it.

The revalidation operator endpoint is temporarily protected by `ETLAYER_REPLAY_KEY`, the same one-time operator credential used by replay acceptance helpers. A future operator-auth abstraction may replace this shared acceptance credential.


## VS4 privacy acceptance

After deploying the current ETLayer Worker and fixture, this helper emits one valid `account.created@1` with two acceptance-only sensitive attributes:

```text
user.email = acceptance@example.test
auth.token = acceptance-secret-do-not-store
```

Run:

```bash
./scripts/once/vs4-privacy-account.sh
```

The helper verifies:

- `auth.token` was removed before canonical R2 storage;
- the secret literal does not exist in the canonical object;
- `user.email` remains in canonical ETLayer storage;
- contract validation remains `valid`;
- privacy evidence records the ingest secret drop;
- privacy evidence records the delivery direct-identifier drop;
- both PostHog and Statsig delivery states are `exported`.

The destination adapters receive the privacy-sanitized event. Live PostHog verification can additionally confirm that the dropped fields are absent from the stored destination properties.


## VS5 identity continuity acceptance

After deploying the current ETLayer Worker and fixture, this helper proves anonymous-to-user identity continuity without any producer-side PostHog or Statsig identify calls.

Run:

```bash
./scripts/once/vs5-identity-continuity.sh
```

The helper creates an isolated session with:

```text
attribution.source   docs
attribution.medium   acceptance
attribution.campaign vs5
```

It then emits:

```text
landing.hero.exposed
        ↓
identity.linked@1
        ↓
account.created
```

and verifies:

- the anonymous event resolves primary identity to `actor.anonymous.id`;
- `identity.linked@1` resolves primary identity to `user.id`;
- the link records an `anonymous_to_user` transition;
- the subsequent account event keeps the same user/anonymous/session/account coordinates;
- attribution is identical across the three events;
- all three events are contract-valid;
- PostHog delivery state is exported for all three;
- Statsig delivery state is exported for all three.

Independent PostHog verification should additionally confirm that `identity.linked` was projected as `$identify`, with `$anon_distinct_id`, and that pre/post-identification events resolve to the same PostHog person.


## VS5 agent delegation acceptance

After deploying the current ETLayer Worker and fixture, run:

```bash
./scripts/once/vs5-agent-delegation.sh
```

The helper creates one attributed product journey and emits:

```text
anonymous hero
  -> identity.linked
  -> account.created
  -> agent.tool.call
  -> agent.subagent.tool.call
```

It verifies:

- the direct agent event has `subject=user` while `actor.type=agent`;
- the direct delegation is `on_behalf_of -> user`;
- the subagent event has `subject=user` while the immediate actor remains the child agent;
- the subagent delegation chain is ordered as:
  - `delegated_by -> parent agent`
  - `on_behalf_of -> user`;
- both agent events are contract-valid;
- session/account/attribution continuity is preserved;
- PostHog and Statsig delivery state is `exported` for both events.

Independent PostHog verification should additionally confirm that both agent events use the same user `distinct_id` while preserving different `actor.id` properties.


## VS6 trusted provenance and authority acceptance

Deploy the current branch and fixture first:

```bash
./scripts/once/deploy-fixture.sh
```

The deploy helper rotates three independent ingest credentials:

```text
browser       -> interaction
backend       -> business_state
agent-runtime -> agent_runtime
```

Then run:

```bash
./scripts/once/vs6-trusted-authority.sh
```

The helper proves:

- browser interaction claims are allowed under trusted browser provenance;
- backend identity/account facts are allowed under trusted backend provenance;
- agent/subagent facts are allowed under trusted agent-runtime provenance;
- browser credentials cannot forge backend/business-state authority;
- agent-runtime credentials cannot forge backend/business-state authority;
- spoof events are still canonically preserved;
- spoof events remain contract-valid so the proof isolates authority enforcement rather than schema failure;
- durable `authority/<event-id>.json` evidence contains exact block reasons;
- blocked spoof events never reach PostHog or Statsig;
- canonical provenance contains no credential material;
- canonical revalidation remains blocked without producer re-emission.

The helper rotates the protected revalidation operator secret and redeploys the current ingest Worker before the revalidation assertion.


## VS7 append-only decision lineage acceptance

Deploy the current branch and fixture first:

```bash
./scripts/once/deploy-fixture.sh
```

Then run:

```bash
./scripts/once/vs7-decision-lineage.sh
```

The helper emits one contract-valid browser credential spoof that remains authority-blocked and verifies:

- initial processing creates `decisions/<event-id>/<decision-id>.json`;
- the decision records contract validator, authority policy, and privacy policy versions;
- `decision-latest/<event-id>.json` points at the initial processing decision;
- the blocked event has no PostHog or Statsig delivery state;
- canonical revalidation creates a distinct decision with `evaluationKind=revalidation`;
- the latest pointer advances to the revalidation decision;
- the original decision record remains present and byte-for-byte unchanged;
- revalidation remains contract-valid, authority-blocked, and unrouted.

The helper rotates the protected revalidation operator secret and redeploys the current ingest Worker before the revalidation assertion.


## VS8 project-scoped configuration and isolation acceptance

Run:

```bash
./scripts/once/vs8-project-isolation.sh
```

The helper is self-contained for acceptance credentials. It rotates the default browser/backend credentials, the secondary backend credential, and both project operator credentials, then keeps the default fixture synchronized.

It proves:

- trusted project identity comes from the authenticated credential, not `etlayer.project.id` in the payload;
- the same logical event ID can exist independently in `etlayer-default` and `etlayer-secondary`;
- canonical, validation, authority, privacy, identity, decision, and delivery evidence is physically project-namespaced;
- the default project routes to PostHog + Statsig;
- the secondary project routes to PostHog only;
- default project operator credentials cannot operate on the secondary project;
- project-scoped source keys cannot be smuggled across revalidation boundaries;
- the secondary project cannot replay Statsig.

Existing VS3-VS7 helpers default to `ETLAYER_PROJECT_ID=etlayer-default` after VS8.

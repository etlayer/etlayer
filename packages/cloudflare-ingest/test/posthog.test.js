import assert from "node:assert/strict";
import test from "node:test";

import {
  exportToPostHog,
  projectToPostHog,
  stablePostHogUuid,
} from "../src/posthog.js";

function event(overrides = {}) {
  return {
    id: "7aa54a8b-1ea8-4acc-93bf-c2305686042e",
    eventName: "account.created",
    occurredAtUnixNano: "1789996800123000000",
    observedAtUnixNano: "1789996800124000000",
    receivedAt: "2026-09-21T16:00:01.000Z",
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "fixture" } },
      ],
    },
    scope: { name: "fixture.scope", version: "0.1.0" },
    logRecord: {
      eventName: "account.created",
      traceId: "abc123",
      spanId: "def456",
      attributes: [
        { key: "user.id", value: { stringValue: "user-42" } },
        { key: "account.id", value: { stringValue: "account-9" } },
        { key: "plan.seats", value: { intValue: "3" } },
      ],
    },
    ...overrides,
  };
}

test("projects a managed event into a PostHog capture payload", async () => {
  const projected = await projectToPostHog(event());

  assert.equal(projected.event, "account.created");
  assert.equal(projected.distinct_id, "user-42");
  assert.equal(projected.uuid, "7aa54a8b-1ea8-4acc-93bf-c2305686042e");
  assert.equal(projected.properties["etlayer.event.id"], event().id);
  assert.equal(projected.properties["service.name"], "fixture");
  assert.equal(projected.properties["plan.seats"], 3);
  assert.equal(projected.properties["otel.scope.name"], "fixture.scope");
  assert.equal(projected.properties["otel.trace_id"], "abc123");
  assert.equal(projected.properties.$process_person_profile, undefined);
});

test("falls back to a non-person synthetic distinct id when no identity exists", async () => {
  const projected = await projectToPostHog(
    event({
      logRecord: {
        eventName: "account.created",
        attributes: [],
      },
    }),
  );

  assert.equal(projected.distinct_id, `etlayer:${event().id}`);
  assert.equal(projected.properties.$process_person_profile, false);
});

test("derives a deterministic UUID when ETLayer event id is not already a UUID", async () => {
  const first = await stablePostHogUuid("evt-readable-id");
  const second = await stablePostHogUuid("evt-readable-id");
  const third = await stablePostHogUuid("evt-other-id");

  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("exports through the PostHog capture API", async () => {
  const calls = [];

  const result = await exportToPostHog(
    event(),
    {
      POSTHOG_PROJECT_TOKEN: "phc_test",
      POSTHOG_HOST: "https://eu.i.posthog.com/",
    },
    {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response("ok", { status: 200 });
      },
    },
  );

  assert.equal(result.status, "exported");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://eu.i.posthog.com/i/v0/e/");

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.api_key, "phc_test");
  assert.equal(body.event, "account.created");
  assert.equal(body.distinct_id, "user-42");
  assert.equal(body.uuid, event().id);
});

test("skips delivery when PostHog projection is intentionally disabled", async () => {
  let called = false;

  const result = await exportToPostHog(
    event(),
    {
      POSTHOG_EXPORT_DISABLED: "1",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      POSTHOG_HOST: "https://eu.i.posthog.com",
    },
    {
      fetch: async () => {
        called = true;
        return new Response("ok");
      },
    },
  );

  assert.deepEqual(result, {
    status: "skipped",
    reason: "posthog_disabled",
  });
  assert.equal(called, false);
});

test("skips delivery when PostHog is not configured", async () => {
  let called = false;

  const result = await exportToPostHog(event(), {}, {
    fetch: async () => {
      called = true;
      return new Response("ok");
    },
  });

  assert.deepEqual(result, {
    status: "skipped",
    reason: "posthog_not_configured",
  });
  assert.equal(called, false);
});

test("refuses to guess a PostHog region when the host is missing", async () => {
  await assert.rejects(
    () =>
      exportToPostHog(event(), {
        POSTHOG_PROJECT_TOKEN: "phc_test",
      }),
    /POSTHOG_HOST is required/,
  );
});

test("throws on destination failure so the queue can retry", async () => {
  await assert.rejects(
    () =>
      exportToPostHog(
        event(),
        {
          POSTHOG_PROJECT_TOKEN: "phc_test",
          POSTHOG_HOST: "https://us.i.posthog.com",
        },
        {
          fetch: async () =>
            new Response("destination unavailable", { status: 503 }),
        },
      ),
    /PostHog capture failed with HTTP 503/,
  );
});


test("projects identity.linked as PostHog anonymous-to-user identify", async () => {
  const linked = event({
    eventName: "identity.linked",
    logRecord: {
      eventName: "identity.linked",
      attributes: [
        { key: "actor.anonymous.id", value: { stringValue: "anon-1" } },
        { key: "user.id", value: { stringValue: "user-1" } },
        { key: "account.id", value: { stringValue: "account-1" } },
        { key: "session.id", value: { stringValue: "session-1" } },
      ],
    },
  });

  const projected = await projectToPostHog(linked);

  assert.equal(projected.event, "$identify");
  assert.equal(projected.distinct_id, "user-1");
  assert.equal(projected.properties.$anon_distinct_id, "anon-1");
  assert.equal(projected.properties["user.id"], "user-1");
  assert.equal(projected.properties["session.id"], "session-1");
  assert.equal(projected.properties.$process_person_profile, undefined);
});


test("agent actor does not replace the user analytics subject in PostHog", async () => {
  const projected = await projectToPostHog(
    event({
      eventName: "agent.tool.call",
      logRecord: {
        eventName: "agent.tool.call",
        attributes: [
          { key: "actor.type", value: { stringValue: "agent" } },
          { key: "actor.id", value: { stringValue: "agent_hanna" } },
          { key: "user.id", value: { stringValue: "usr_42" } },
          { key: "account.id", value: { stringValue: "account_1" } },
          { key: "session.id", value: { stringValue: "session_1" } },
          { key: "delegation.0.relationship", value: { stringValue: "on_behalf_of" } },
          { key: "delegation.0.principal.type", value: { stringValue: "user" } },
          { key: "delegation.0.principal.id", value: { stringValue: "usr_42" } },
        ],
      },
    }),
  );

  assert.equal(projected.event, "agent.tool.call");
  assert.equal(projected.distinct_id, "usr_42");
  assert.equal(projected.properties["actor.type"], "agent");
  assert.equal(projected.properties["actor.id"], "agent_hanna");
  assert.equal(
    projected.properties["delegation.0.principal.id"],
    "usr_42",
  );
});

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

test("throws on destination failure so the queue can retry", async () => {
  await assert.rejects(
    () =>
      exportToPostHog(
        event(),
        { POSTHOG_PROJECT_TOKEN: "phc_test" },
        {
          fetch: async () =>
            new Response("destination unavailable", { status: 503 }),
        },
      ),
    /PostHog capture failed with HTTP 503/,
  );
});

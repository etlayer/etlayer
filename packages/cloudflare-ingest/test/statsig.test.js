import assert from "node:assert/strict";
import test from "node:test";

import {
  StatsigExportError,
  exportToStatsig,
  projectToStatsig,
} from "../src/statsig.js";

function managedEvent(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    eventName: "landing.hero.cta_clicked",
    receivedAt: "2026-09-22T10:00:01.000Z",
    occurredAtUnixNano: "1790071200000000000",
    resource: {
      attributes: [
        {
          key: "service.name",
          value: { stringValue: "fixture" },
        },
      ],
    },
    scope: {
      name: "etlayer.fixture",
      version: "0.2.0",
    },
    logRecord: {
      attributes: [
        {
          key: "user.id",
          value: { stringValue: "user_123" },
        },
        {
          key: "actor.anonymous.id",
          value: { stringValue: "anon_456" },
        },
        {
          key: "account.id",
          value: { stringValue: "account_789" },
        },
        {
          key: "correlation.id",
          value: { stringValue: "corr_1" },
        },
        {
          key: "causation.id",
          value: { stringValue: "cause_1" },
        },
        {
          key: "experiment.id",
          value: { stringValue: "hero.v1" },
        },
      ],
    },
    ...overrides,
  };
}

test("projects a managed event to a Statsig custom event", () => {
  const payload = projectToStatsig(managedEvent());

  assert.equal(payload.eventName, "landing.hero.cta_clicked");
  assert.equal(payload.time, "2026-09-22T10:00:00.000Z");
  assert.equal(payload.user.userID, "user_123");
  assert.deepEqual(payload.user.customIDs, {
    anonymousID: "anon_456",
    accountID: "account_789",
  });
  assert.equal(
    payload.metadata["etlayer.event.id"],
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(payload.metadata["correlation.id"], "corr_1");
  assert.equal(payload.metadata["causation.id"], "cause_1");
  assert.equal(payload.metadata["experiment.id"], "hero.v1");
});

test("uses anonymous identity when user.id is absent", () => {
  const event = managedEvent({
    logRecord: {
      attributes: [
        {
          key: "actor.anonymous.id",
          value: { stringValue: "anon_456" },
        },
      ],
    },
  });

  const payload = projectToStatsig(event);
  assert.equal(payload.user.userID, undefined);
  assert.deepEqual(payload.user.customIDs, {
    anonymousID: "anon_456",
  });
});

test("does not reinterpret a product exposure event as a Statsig exposure", () => {
  const payload = projectToStatsig(
    managedEvent({ eventName: "landing.hero.exposed" }),
  );

  assert.equal(payload.eventName, "landing.hero.exposed");
  assert.equal("experimentName" in payload, false);
  assert.equal("exposures" in payload, false);
});

test("skips Statsig cleanly when it is not configured", async () => {
  const result = await exportToStatsig(managedEvent(), {});

  assert.deepEqual(result, {
    status: "skipped",
    reason: "statsig_not_configured",
  });
});

test("posts one custom event with the server secret", async () => {
  const requests = [];

  const result = await exportToStatsig(
    managedEvent(),
    {
      STATSIG_SERVER_SECRET: "secret-test",
      STATSIG_HOST: "https://api.statsig.test",
    },
    {
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response('{"success":true}', { status: 202 });
      },
    },
  );

  assert.equal(result.status, "exported");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.statsig.test/v1/log_event");
  assert.equal(
    requests[0].init.headers["statsig-api-key"],
    "secret-test",
  );

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].eventName, "landing.hero.cta_clicked");
});

test("surfaces Statsig HTTP failures", async () => {
  await assert.rejects(
    exportToStatsig(
      managedEvent(),
      {
        STATSIG_SERVER_SECRET: "secret-test",
      },
      {
        fetch: async () =>
          new Response('{"success":false}', { status: 503 }),
      },
    ),
    (error) =>
      error instanceof StatsigExportError &&
      error.status === 503,
  );
});

test("can be deliberately disabled for destination outage acceptance", async () => {
  const result = await exportToStatsig(managedEvent(), {
    STATSIG_EXPORT_DISABLED: "1",
    STATSIG_SERVER_SECRET: "secret-test",
  });

  assert.deepEqual(result, {
    status: "skipped",
    reason: "statsig_disabled",
  });
});


test("identified Statsig event carries all known IDs", () => {
  const payload = projectToStatsig(
    managedEvent({
      eventName: "identity.linked",
      logRecord: {
        attributes: [
          { key: "user.id", value: { stringValue: "user_123" } },
          { key: "actor.anonymous.id", value: { stringValue: "anon_456" } },
          { key: "session.id", value: { stringValue: "session_777" } },
          { key: "account.id", value: { stringValue: "account_789" } },
        ],
      },
    }),
  );

  assert.equal(payload.user.userID, "user_123");
  assert.deepEqual(payload.user.customIDs, {
    anonymousID: "anon_456",
    sessionID: "session_777",
    accountID: "account_789",
  });
});

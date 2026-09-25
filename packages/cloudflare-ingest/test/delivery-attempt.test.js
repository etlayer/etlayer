import assert from "node:assert/strict";
import test from "node:test";

import {
  deliveryAttemptKey,
  deliveryResourceId,
  historicalAttemptCount,
  listDeliveryAttempts,
  nextDeliveryAttemptNumber,
  recordDeliveryAttempt,
} from "../src/delivery-attempt.js";

function archive() {
  const objects = new Map();

  return {
    objects,
    async put(key, body, options = {}) {
      if (
        options.onlyIf?.etagDoesNotMatch === "*" &&
        objects.has(key)
      ) {
        return null;
      }

      objects.set(key, body);
      return { key };
    },
    async get(key) {
      const body = objects.get(key);
      if (body == null) return null;
      return {
        async text() {
          return body;
        },
      };
    },
    async list({ prefix }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}

function event() {
  return {
    id: "evt/1",
    eventName: "account.created",
    provenance: {
      version: 2,
      projectId: "project-a",
      profileId: "backend",
      producer: { kind: "backend" },
      allowedAuthorityKinds: [
        "business_state",
      ],
    },
  };
}

test("records immutable numbered delivery attempts", async () => {
  const store = archive();
  const managedEvent = event();

  const first = await recordDeliveryAttempt(
    store,
    managedEvent,
    "posthog",
    {
      status: "skipped",
      reason: "posthog_not_configured",
    },
    {
      attemptId: "attempt-1",
      attemptNumber: 1,
      startedAt:
        new Date("2026-09-24T15:00:00Z"),
      completedAt:
        new Date("2026-09-24T15:00:01Z"),
    },
  );

  const second = await recordDeliveryAttempt(
    store,
    managedEvent,
    "posthog",
    {
      status: "exported",
      uuid: "destination-event-1",
    },
    {
      attemptId: "attempt-2",
      attemptNumber: 2,
      startedAt:
        new Date("2026-09-24T15:01:00Z"),
      completedAt:
        new Date("2026-09-24T15:01:01Z"),
      delivery: {
        mode: "replay",
        replayId: "replay-1",
      },
    },
  );

  assert.equal(
    first.state.deliveryId,
    second.state.deliveryId,
  );
  assert.equal(
    first.state.deliveryId,
    deliveryResourceId(
      managedEvent.id,
      "posthog",
      "project-a",
    ),
  );
  assert.equal(first.state.attemptNumber, 1);
  assert.equal(second.state.attemptNumber, 2);
  assert.equal(second.state.mode, "replay");
  assert.equal(second.state.replayId, "replay-1");

  const attempts = await listDeliveryAttempts(
    store,
    managedEvent.id,
    "posthog",
    { projectId: "project-a" },
  );

  assert.deepEqual(
    attempts.map(
      ({
        attemptId,
        attemptNumber,
        status,
      }) => [
        attemptId,
        attemptNumber,
        status,
      ],
    ),
    [
      ["attempt-1", 1, "skipped"],
      ["attempt-2", 2, "exported"],
    ],
  );
});

test("attempt keys are append-only", async () => {
  const store = archive();
  const managedEvent = event();

  await recordDeliveryAttempt(
    store,
    managedEvent,
    "posthog",
    {
      status: "failed",
      error: new Error("down"),
    },
    {
      attemptId: "attempt-fixed",
      attemptNumber: 1,
    },
  );

  await assert.rejects(
    () =>
      recordDeliveryAttempt(
        store,
        managedEvent,
        "posthog",
        { status: "exported" },
        {
          attemptId: "attempt-fixed",
          attemptNumber: 1,
        },
      ),
    /already exists/,
  );

  assert.equal(
    deliveryAttemptKey(
      "posthog",
      "evt/1",
      1,
      "attempt-fixed",
      "project-a",
    ),
    "projects/project-a/delivery-attempts/posthog/evt%2F1/000001--attempt-fixed.json",
  );
});

test("historical v1/v2 summary reserves attempt number one without synthesizing an object", async () => {
  const store = archive();

  assert.equal(historicalAttemptCount(null), 0);
  assert.equal(
    historicalAttemptCount({
      version: 2,
      status: "failed",
    }),
    1,
  );

  const next = await nextDeliveryAttemptNumber(
    store,
    "evt-historical",
    "posthog",
    {
      projectId: "project-a",
      previousState: {
        version: 2,
        status: "failed",
      },
    },
  );

  assert.equal(next, 2);
  assert.equal(store.objects.size, 0);
});

test("next attempt number uses append-only history even if summary is stale", async () => {
  const store = archive();
  const managedEvent = event();

  await recordDeliveryAttempt(
    store,
    managedEvent,
    "posthog",
    { status: "failed" },
    {
      attemptId: "attempt-2",
      attemptNumber: 2,
    },
  );

  await recordDeliveryAttempt(
    store,
    managedEvent,
    "posthog",
    { status: "failed" },
    {
      attemptId: "attempt-3",
      attemptNumber: 3,
    },
  );

  const next = await nextDeliveryAttemptNumber(
    store,
    managedEvent.id,
    "posthog",
    {
      projectId: "project-a",
      previousState: {
        version: 3,
        attemptCount: 1,
        status: "failed",
      },
    },
  );

  assert.equal(next, 4);
});

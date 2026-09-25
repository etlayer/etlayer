import assert from "node:assert/strict";
import test from "node:test";

import {
  deliveryStateKey,
  readDeliveryState,
  recordDeliveryState,
} from "../src/delivery-state.js";
import {
  deliveryResourceId,
} from "../src/delivery-attempt.js";

function fakeArchive() {
  const writes = [];

  return {
    writes,
    async put(key, body, options) {
      writes.push({ key, body, options });
    },
  };
}

test("records exported destination state separately from canonical events", async () => {
  const archive = fakeArchive();
  const event = {
    id: "evt/1",
    eventName: "account.created",
  };

  const recorded = await recordDeliveryState(
    archive,
    event,
    "posthog",
    {
      status: "exported",
      uuid: "uuid-1",
    },
    {
      now: new Date("2026-09-22T10:00:00.000Z"),
    },
  );

  assert.equal(
    recorded.key,
    "projects/etlayer-default/deliveries/posthog/evt%2F1.json",
  );
  assert.equal(archive.writes.length, 1);

  const body = JSON.parse(archive.writes[0].body);
  assert.equal(body.version, 3);
  assert.equal(body.eventId, "evt/1");
  assert.equal(body.destination, "posthog");
  assert.equal(body.status, "exported");
  assert.equal(
    body.deliveryId,
    deliveryResourceId(
      "evt/1",
      "posthog",
      "etlayer-default",
    ),
  );
  assert.equal(body.destinationEventId, "uuid-1");
  assert.equal(body.updatedAt, "2026-09-22T10:00:00.000Z");
});

test("records failed destination state with a serializable error", async () => {
  const archive = fakeArchive();
  const error = new Error("upstream unavailable");
  error.status = 503;

  await recordDeliveryState(
    archive,
    {
      id: "evt_2",
      eventName: "landing.hero.exposed",
    },
    "statsig",
    {
      status: "failed",
      error,
    },
    {
      now: new Date("2026-09-22T10:01:00.000Z"),
    },
  );

  const body = JSON.parse(archive.writes[0].body);
  assert.equal(body.status, "failed");
  assert.deepEqual(body.error, {
    name: "Error",
    message: "upstream unavailable",
    status: 503,
  });
});

test("uses deterministic per-destination delivery state keys", () => {
  assert.equal(
    deliveryStateKey("statsig", "event 1"),
    "projects/etlayer-default/deliveries/statsig/event%201.json",
  );
});


test("reads a previously recorded delivery state", async () => {
  const key = deliveryStateKey("statsig", "evt_3");
  const state = {
    version: 1,
    eventId: "evt_3",
    eventName: "account.created",
    destination: "statsig",
    status: "exported",
    updatedAt: "2026-09-22T10:02:00.000Z",
  };

  const archive = {
    async get(requestedKey) {
      assert.equal(requestedKey, key);
      return {
        async text() {
          return JSON.stringify(state);
        },
      };
    },
  };

  assert.deepEqual(
    await readDeliveryState(archive, "evt_3", "statsig"),
    state,
  );
});

test("returns null when delivery state does not exist", async () => {
  const archive = {
    async get() {
      return null;
    },
  };

  assert.equal(
    await readDeliveryState(archive, "evt_missing", "statsig"),
    null,
  );
});

test("delivery v3 summary points to the latest immutable attempt", async () => {
  const archive = fakeArchive();
  const managedEvent = {
    id: "evt_4",
    eventName: "checkout.completed",
  };
  const deliveryId = deliveryResourceId(
    managedEvent.id,
    "posthog",
    "etlayer-default",
  );

  await recordDeliveryState(
    archive,
    managedEvent,
    "posthog",
    {
      status: "exported",
      uuid: "ph-evt-4",
    },
    {
      now: new Date(
        "2026-09-22T10:03:00.000Z",
      ),
      delivery: {
        mode: "revalidation",
      },
      attempt: {
        deliveryId,
        attemptId: "attempt-2",
        attemptNumber: 2,
        completedAt:
          "2026-09-22T10:03:00.000Z",
      },
    },
  );

  const body = JSON.parse(
    archive.writes[0].body,
  );

  assert.equal(body.deliveryId, deliveryId);
  assert.equal(body.attemptCount, 2);
  assert.equal(body.latestAttemptId, "attempt-2");
  assert.equal(body.latestAttemptNumber, 2);
  assert.equal(
    body.lastAttemptAt,
    "2026-09-22T10:03:00.000Z",
  );
  assert.equal(
    body.deliveryMode,
    "revalidation",
  );
});


import assert from "node:assert/strict";
import test from "node:test";

import {
  deliveryStateKey,
  recordDeliveryState,
} from "../src/delivery-state.js";

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
    "deliveries/posthog/evt%2F1.json",
  );
  assert.equal(archive.writes.length, 1);

  const body = JSON.parse(archive.writes[0].body);
  assert.equal(body.eventId, "evt/1");
  assert.equal(body.destination, "posthog");
  assert.equal(body.status, "exported");
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
    "deliveries/statsig/event%201.json",
  );
});

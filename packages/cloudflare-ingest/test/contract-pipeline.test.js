import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

function attribute(key, value) {
  if (typeof value === "string") {
    return { key, value: { stringValue: value } };
  }

  return { key, value: { intValue: String(value) } };
}

function invalidAccountEvent() {
  return {
    id: "evt-blocked-1",
    eventName: "account.created",
    receivedAt: "2026-09-22T00:20:00.000Z",
    resource: {},
    scope: {},
    logRecord: {
      eventName: "account.created",
      attributes: [
        attribute("etlayer.schema.version", 1),
        attribute("actor.anonymous.id", "anon_1"),
        attribute("correlation.id", "corr_1"),
        attribute("causation.id", "cause_1"),
        attribute("etlayer.producer.kind", "backend"),
        attribute("etlayer.authority.kind", "business_state"),
      ],
    },
  };
}

function fakeArchive() {
  const objects = new Map();
  const writes = [];

  return {
    objects,
    writes,
    async put(key, body, options = {}) {
      if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) {
        return null;
      }

      writes.push(key);
      objects.set(key, {
        body,
        customMetadata: options.customMetadata || {},
      });

      return { key };
    },
    async head(key) {
      const object = objects.get(key);
      return object
        ? { key, customMetadata: object.customMetadata }
        : null;
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        async text() {
          return object.body;
        },
      };
    },
  };
}

test("queue preserves an invalid event before blocking destination routing", async () => {
  const archive = fakeArchive();
  const message = {
    body: invalidAccountEvent(),
    ackCount: 0,
    retryCount: 0,
    ack() {
      this.ackCount += 1;
    },
    retry() {
      this.retryCount += 1;
    },
  };

  await worker.queue(
    { messages: [message] },
    { ARCHIVE: archive },
  );

  assert.equal(message.ackCount, 1);
  assert.equal(message.retryCount, 0);

  assert.deepEqual(archive.writes, [
    "events/2026/09/22/00/evt-blocked-1.json",
    "validation/evt-blocked-1.json",
    "privacy/evt-blocked-1.json",
  ]);

  const validation = JSON.parse(
    archive.objects.get("validation/evt-blocked-1.json").body,
  );

  assert.equal(validation.status, "blocked");
  assert.equal(
    validation.sourceKey,
    "events/2026/09/22/00/evt-blocked-1.json",
  );
  assert.deepEqual(validation.errors, [
    {
      code: "required_attribute_missing",
      attribute: "account.id",
    },
  ]);

  assert.equal(
    [...archive.objects.keys()].some((key) =>
      key.startsWith("deliveries/"),
    ),
    false,
  );
});

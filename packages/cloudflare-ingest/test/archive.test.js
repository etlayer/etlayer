import assert from "node:assert/strict";
import test from "node:test";

import {
  archiveKey,
  consumeEventBatch,
  EventIdConflictError,
  persistManagedEvent,
} from "../src/archive.js";

function event(overrides = {}) {
  return {
    id: "evt/123",
    eventName: "account.created",
    receivedAt: "2026-09-21T16:20:30.000Z",
    resource: {},
    scope: {},
    logRecord: { eventName: "account.created" },
    ...overrides,
  };
}

function fakeArchive() {
  const objects = new Map();
  let writes = 0;

  return {
    objects,
    get writes() {
      return writes;
    },
    async put(key, body, options = {}) {
      if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) {
        return null;
      }

      writes += 1;
      objects.set(key, {
        body,
        customMetadata: options.customMetadata || {},
        httpMetadata: options.httpMetadata || {},
      });

      return { key, customMetadata: options.customMetadata || {} };
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { key, customMetadata: object.customMetadata } : null;
    },
  };
}

function queueMessage(body) {
  return {
    body,
    ackCount: 0,
    retryCount: 0,
    ack() {
      this.ackCount += 1;
    },
    retry() {
      this.retryCount += 1;
    },
  };
}

test("builds a deterministic UTC archive key and encodes event ids", () => {
  assert.equal(
    archiveKey(event()),
    "events/2026/09/21/16/evt%2F123.json",
  );
});

test("stores a new event immutably with replay metadata", async () => {
  const archive = fakeArchive();
  const result = await persistManagedEvent(archive, event());

  assert.equal(result.status, "stored");
  assert.equal(archive.writes, 1);

  const stored = archive.objects.get(result.key);
  assert.equal(JSON.parse(stored.body).id, "evt/123");
  assert.equal(stored.customMetadata.event_id, "evt/123");
  assert.equal(stored.customMetadata.event_name, "account.created");
  assert.match(stored.customMetadata.sha256, /^[a-f0-9]{64}$/);
});

test("treats an identical repeated event as a duplicate without overwriting it", async () => {
  const archive = fakeArchive();

  await persistManagedEvent(archive, event());
  const result = await persistManagedEvent(archive, event());

  assert.equal(result.status, "duplicate");
  assert.equal(archive.writes, 1);
});

test("rejects the same archive identity when the payload differs", async () => {
  const archive = fakeArchive();

  await persistManagedEvent(archive, event());

  await assert.rejects(
    () => persistManagedEvent(
      archive,
      event({ eventName: "account.deleted" }),
    ),
    EventIdConflictError,
  );

  assert.equal(archive.writes, 1);
});

test("acks stored and duplicate queue deliveries", async () => {
  const archive = fakeArchive();
  const first = queueMessage(event());
  const duplicate = queueMessage(event());
  const logger = { error() {} };

  await consumeEventBatch(
    { messages: [first] },
    { ARCHIVE: archive },
    { logger },
  );

  await consumeEventBatch(
    { messages: [duplicate] },
    { ARCHIVE: archive },
    { logger },
  );

  assert.equal(first.ackCount, 1);
  assert.equal(first.retryCount, 0);
  assert.equal(duplicate.ackCount, 1);
  assert.equal(duplicate.retryCount, 0);
});

test("retries only the conflicting message in a mixed batch", async () => {
  const archive = fakeArchive();

  await persistManagedEvent(archive, event());

  const conflict = queueMessage(
    event({ eventName: "account.deleted" }),
  );
  const fresh = queueMessage(event({ id: "evt-456" }));
  const logger = { error() {} };

  await consumeEventBatch(
    { messages: [conflict, fresh] },
    { ARCHIVE: archive },
    { logger },
  );

  assert.equal(conflict.ackCount, 0);
  assert.equal(conflict.retryCount, 1);
  assert.equal(fresh.ackCount, 1);
  assert.equal(fresh.retryCount, 0);
});

test("retries queue messages when the archive binding is missing", async () => {
  const message = queueMessage(event());
  const logger = { error() {} };

  await consumeEventBatch({ messages: [message] }, {}, { logger });

  assert.equal(message.ackCount, 0);
  assert.equal(message.retryCount, 1);
});

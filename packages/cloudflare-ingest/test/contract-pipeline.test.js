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
    id: "evt-quarantined-1",
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

test("queue preserves an invalid event in quarantine without destination routing", async () => {
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

  assert.deepEqual(archive.writes.slice(0, 5), [
    "projects/etlayer-default/events/2026/09/22/00/evt-quarantined-1.json",
    "projects/etlayer-default/validation/evt-quarantined-1.json",
    "projects/etlayer-default/authority/evt-quarantined-1.json",
    "projects/etlayer-default/privacy/evt-quarantined-1.json",
    "projects/etlayer-default/identity/evt-quarantined-1.json",
  ]);

  const decisionKey = archive.writes.find((key) =>
    key.startsWith("projects/etlayer-default/decisions/evt-quarantined-1/"),
  );

  assert.ok(decisionKey);
  assert.equal(
    archive.writes.includes("projects/etlayer-default/decision-latest/evt-quarantined-1.json"),
    true,
  );

  const decision = JSON.parse(
    archive.objects.get(decisionKey).body,
  );

  assert.equal(decision.validation.status, "quarantined");
  assert.equal(decision.validation.validatorVersion, 1);
  assert.equal(decision.authority.policyVersion, 1);
  assert.equal(decision.privacy.policyVersion, 1);
  assert.equal(decision.outcome, "quarantine");
  assert.equal(decision.routeEligible, false);

  const validation = JSON.parse(
    archive.objects.get("projects/etlayer-default/validation/evt-quarantined-1.json").body,
  );

  assert.equal(validation.status, "quarantined");
  assert.equal(
    validation.sourceKey,
    "projects/etlayer-default/events/2026/09/22/00/evt-quarantined-1.json",
  );
  assert.deepEqual(validation.errors, [
    {
      code: "required_attribute_missing",
      attribute: "account.id",
    },
  ]);

  assert.equal(
    [...archive.objects.keys()].some((key) =>
      key.startsWith("projects/etlayer-default/deliveries/"),
    ),
    false,
  );
});

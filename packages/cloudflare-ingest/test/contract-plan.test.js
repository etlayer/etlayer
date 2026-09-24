import assert from "node:assert/strict";
import test from "node:test";

import { archiveKey } from "../src/archive.js";
import { planContractChange } from "../src/contract-plan.js";

function attribute(key, value) {
  if (typeof value === "string") {
    return { key, value: { stringValue: value } };
  }

  return {
    key,
    value: { intValue: String(value) },
  };
}

function event({
  id,
  accountId = "account-1",
  planId,
  receivedAt,
  authority = "business_state",
}) {
  const attributes = [
    attribute("etlayer.schema.version", 1),
    attribute("actor.anonymous.id", "anon-1"),
    attribute("correlation.id", "corr-1"),
    attribute("causation.id", "cause-1"),
    attribute("etlayer.producer.kind", "backend"),
    attribute("etlayer.authority.kind", authority),
  ];

  if (accountId != null) {
    attributes.push(
      attribute("account.id", accountId),
    );
  }

  if (planId != null) {
    attributes.push(
      attribute("plan.id", planId),
    );
  }

  return {
    id,
    eventName: "account.created",
    receivedAt,
    provenance: {
      version: 2,
      projectId: "plan-project",
      profileId: "backend",
      producer: { kind: "backend" },
      allowedAuthorityKinds: ["business_state"],
    },
    logRecord: {
      eventName: "account.created",
      attributes,
    },
  };
}

function archive(events) {
  const objects = new Map(
    events.map((item) => [
      archiveKey(item),
      JSON.stringify(item),
    ]),
  );
  let writes = 0;

  return {
    get writes() {
      return writes;
    },
    async list({ prefix }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
    async get(key) {
      const body = objects.get(key);
      if (!body) return null;
      return {
        async text() {
          return body;
        },
      };
    },
    async put() {
      writes += 1;
      throw new Error(
        "contract plan must be read-only",
      );
    },
  };
}

const proposed = {
  id: "account.created@2",
  eventName: "account.created",
  version: 2,
  required: {
    "actor.anonymous.id": { type: "string" },
    "account.id": { type: "string" },
    "correlation.id": { type: "string" },
    "causation.id": { type: "string" },
    "plan.id": { type: "string" },
    "etlayer.producer.kind": {
      type: "string",
      const: "backend",
    },
    "etlayer.authority.kind": {
      type: "string",
      const: "business_state",
    },
  },
  forbidden: [
    "experiment.id",
    "experiment.variant",
  ],
};

test("plans historical contract impact without mutating durable state", async () => {
  const events = [
    event({
      id: "evt-still-allow",
      planId: "pro",
      receivedAt: "2026-09-24T13:00:01.000Z",
    }),
    event({
      id: "evt-new-quarantine",
      receivedAt: "2026-09-24T13:00:02.000Z",
    }),
    event({
      id: "evt-still-quarantine",
      accountId: null,
      planId: "pro",
      receivedAt: "2026-09-24T13:00:03.000Z",
    }),
  ];
  const store = archive(events);

  const result = await planContractChange(
    { ARCHIVE: store },
    {
      projectId: "plan-project",
      eventName: "account.created",
      currentVersion: 1,
      proposedContract: proposed,
      from: "2026-09-24T13:00:00.000Z",
      to: "2026-09-24T13:01:00.000Z",
      compatibilityMode: "backward",
    },
  );

  assert.equal(result.selected, 3);
  assert.equal(result.changed, 1);
  assert.deepEqual(result.transitions, {
    allow_to_allow: 1,
    allow_to_quarantine: 1,
    quarantine_to_quarantine: 1,
  });
  assert.equal(
    result.compatibility.compatible,
    false,
  );
  assert.equal(
    result.compatibility.backward.violations.some(
      (item) =>
        item.code === "required_attribute_added" &&
        item.attribute === "plan.id",
    ),
    true,
  );
  assert.equal(result.examples.length, 1);
  assert.equal(
    result.examples[0].eventId,
    "evt-new-quarantine",
  );
  assert.equal(
    result.examples[0].proposedValidation.errors[0].attribute,
    "plan.id",
  );
  assert.equal(store.writes, 0);
});

test("authority denial remains blocked under contract-only planning", async () => {
  const blocked = event({
    id: "evt-blocked",
    planId: "pro",
    authority: "interaction",
    receivedAt: "2026-09-24T13:00:04.000Z",
  });
  const store = archive([blocked]);

  const result = await planContractChange(
    { ARCHIVE: store },
    {
      projectId: "plan-project",
      eventName: "account.created",
      currentVersion: 1,
      proposedContract: proposed,
      from: "2026-09-24T13:00:00.000Z",
      to: "2026-09-24T13:01:00.000Z",
    },
  );

  assert.deepEqual(result.transitions, {
    block_to_block: 1,
  });
  assert.equal(result.changed, 0);
  assert.equal(store.writes, 0);
});

test("filters unrelated events before the maxEvents limit is applied", async () => {
  const matching = event({
    id: "evt-match",
    receivedAt: "2026-09-24T13:00:10.000Z",
  });
  const unrelated = {
    ...event({
      id: "evt-other",
      receivedAt: "2026-09-24T13:00:05.000Z",
    }),
    eventName: "other.event",
    logRecord: {
      eventName: "other.event",
      attributes: [
        attribute("etlayer.schema.version", 1),
      ],
    },
  };
  const store = archive([unrelated, matching]);

  const result = await planContractChange(
    { ARCHIVE: store },
    {
      projectId: "plan-project",
      eventName: "account.created",
      currentVersion: 1,
      proposedContract: proposed,
      from: "2026-09-24T13:00:00.000Z",
      to: "2026-09-24T13:01:00.000Z",
      maxEvents: 1,
    },
  );

  assert.equal(result.selected, 1);
  assert.equal(
    result.examples[0].eventId,
    "evt-match",
  );
});

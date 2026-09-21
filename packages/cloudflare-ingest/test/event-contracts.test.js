import assert from "node:assert/strict";
import test from "node:test";

import { validateEventContract } from "../src/event-contracts.js";

function attribute(key, value) {
  if (typeof value === "string") {
    return { key, value: { stringValue: value } };
  }

  if (typeof value === "boolean") {
    return { key, value: { boolValue: value } };
  }

  if (Number.isSafeInteger(value)) {
    return { key, value: { intValue: String(value) } };
  }

  return { key, value: { doubleValue: value } };
}

function event(eventName, attributes) {
  return {
    id: "evt_1",
    eventName,
    receivedAt: "2026-09-22T00:00:00.000Z",
    resource: {},
    scope: {},
    logRecord: {
      eventName,
      attributes: Object.entries(attributes).map(([key, value]) =>
        attribute(key, value),
      ),
    },
  };
}

test("validates the reference hero exposure contract", () => {
  const result = validateEventContract(
    event("landing.hero.exposed", {
      "etlayer.schema.version": 1,
      "actor.anonymous.id": "anon_1",
      "correlation.id": "corr_1",
      "etlayer.producer.kind": "browser",
      "etlayer.authority.kind": "interaction",
      "experiment.id": "hero.v1",
      "experiment.variant": "fixture-a",
    }),
  );

  assert.deepEqual(result, {
    status: "valid",
    schemaVersion: 1,
    contractId: "landing.hero.exposed@1",
    errors: [],
  });
});

test("blocks account.created when account.id is missing", () => {
  const result = validateEventContract(
    event("account.created", {
      "etlayer.schema.version": 1,
      "actor.anonymous.id": "anon_1",
      "correlation.id": "corr_1",
      "causation.id": "cause_1",
      "etlayer.producer.kind": "backend",
      "etlayer.authority.kind": "business_state",
    }),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.contractId, "account.created@1");
  assert.deepEqual(result.errors, [
    {
      code: "required_attribute_missing",
      attribute: "account.id",
    },
  ]);
});

test("blocks forbidden experiment context on account.created", () => {
  const result = validateEventContract(
    event("account.created", {
      "etlayer.schema.version": 1,
      "actor.anonymous.id": "anon_1",
      "account.id": "account_1",
      "correlation.id": "corr_1",
      "causation.id": "cause_1",
      "etlayer.producer.kind": "backend",
      "etlayer.authority.kind": "business_state",
      "experiment.id": "hero.v1",
      "experiment.variant": "fixture-a",
    }),
  );

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.errors, [
    {
      code: "forbidden_attribute_present",
      attribute: "experiment.id",
    },
    {
      code: "forbidden_attribute_present",
      attribute: "experiment.variant",
    },
  ]);
});

test("blocks an authority mismatch with an exact machine-readable error", () => {
  const result = validateEventContract(
    event("account.created", {
      "etlayer.schema.version": 1,
      "actor.anonymous.id": "anon_1",
      "account.id": "account_1",
      "correlation.id": "corr_1",
      "causation.id": "cause_1",
      "etlayer.producer.kind": "backend",
      "etlayer.authority.kind": "interaction",
    }),
  );

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.errors, [
    {
      code: "attribute_value_mismatch",
      attribute: "etlayer.authority.kind",
      expected: "business_state",
      actual: "interaction",
    },
  ]);
});

test("treats unversioned events as unmanaged during migration", () => {
  const result = validateEventContract(
    event("legacy.smoke", {
      "correlation.id": "corr_1",
    }),
  );

  assert.deepEqual(result, {
    status: "unmanaged",
    schemaVersion: null,
    contractId: null,
    errors: [],
  });
});

test("blocks a versioned event with no matching contract", () => {
  const result = validateEventContract(
    event("unknown.product.event", {
      "etlayer.schema.version": 1,
    }),
  );

  assert.deepEqual(result, {
    status: "blocked",
    schemaVersion: 1,
    contractId: null,
    errors: [
      {
        code: "contract_not_found",
        eventName: "unknown.product.event",
        schemaVersion: 1,
      },
    ],
  });
});

test("validation is deterministic for repeated processing", () => {
  const managed = event("account.created", {
    "etlayer.schema.version": 1,
    "actor.anonymous.id": "anon_1",
    "correlation.id": "corr_1",
    "causation.id": "cause_1",
    "etlayer.producer.kind": "backend",
    "etlayer.authority.kind": "business_state",
  });

  assert.deepEqual(
    validateEventContract(managed),
    validateEventContract(managed),
  );
});

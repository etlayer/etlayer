import assert from "node:assert/strict";
import test from "node:test";

import {
  readValidationState,
  recordValidationState,
  validationStateKey,
} from "../src/validation-state.js";

function fakeArchive() {
  const objects = new Map();

  return {
    objects,
    async put(key, body, options = {}) {
      objects.set(key, {
        body,
        customMetadata: options.customMetadata || {},
      });
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

test("records blocked validation evidence durably", async () => {
  const archive = fakeArchive();
  const event = {
    id: "evt/blocked",
    eventName: "account.created",
  };

  const result = await recordValidationState(
    archive,
    event,
    {
      status: "blocked",
      validatorVersion: 1,
      schemaVersion: 1,
      contractId: "account.created@1",
      errors: [
        {
          code: "required_attribute_missing",
          attribute: "account.id",
        },
      ],
    },
    {
      now: new Date("2026-09-22T00:10:00.000Z"),
      sourceKey: "events/2026/09/22/00/evt%2Fblocked.json",
    },
  );

  assert.equal(
    result.key,
    "validation/evt%2Fblocked.json",
  );

  const state = JSON.parse(
    archive.objects.get(result.key).body,
  );

  assert.deepEqual(state, {
    version: 1,
    eventId: "evt/blocked",
    eventName: "account.created",
    validatorVersion: 1,
    schemaVersion: 1,
    status: "blocked",
    contractId: "account.created@1",
    errors: [
      {
        code: "required_attribute_missing",
        attribute: "account.id",
      },
    ],
    sourceKey: "events/2026/09/22/00/evt%2Fblocked.json",
    updatedAt: "2026-09-22T00:10:00.000Z",
  });
});

test("reads validation state for later diagnosis or reprocessing", async () => {
  const archive = fakeArchive();
  const event = {
    id: "evt_2",
    eventName: "landing.hero.exposed",
  };

  await recordValidationState(
    archive,
    event,
    {
      status: "valid",
      validatorVersion: 1,
      schemaVersion: 1,
      contractId: "landing.hero.exposed@1",
      errors: [],
    },
    {
      now: new Date("2026-09-22T00:11:00.000Z"),
    },
  );

  const state = await readValidationState(archive, "evt_2");
  assert.equal(state.status, "valid");
  assert.equal(state.contractId, "landing.hero.exposed@1");
});

test("validation state key is deterministic", () => {
  assert.equal(
    validationStateKey("event 1"),
    "validation/event%201.json",
  );
});

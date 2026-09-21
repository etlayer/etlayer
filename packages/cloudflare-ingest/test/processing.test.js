import assert from "node:assert/strict";
import test from "node:test";

import { processPersistedEvent } from "../src/processing.js";

test("blocked validation records evidence and never routes", async () => {
  const calls = [];

  const result = await processPersistedEvent(
    { id: "evt_1", eventName: "account.created" },
    { ARCHIVE: {} },
    {
      validate() {
        calls.push("validate");
        return {
          status: "blocked",
          schemaVersion: 1,
          contractId: "account.created@1",
          errors: [
            {
              code: "required_attribute_missing",
              attribute: "account.id",
            },
          ],
        };
      },
      async recordValidationState() {
        calls.push("record");
      },
      async route() {
        calls.push("route");
        return [];
      },
    },
  );

  assert.deepEqual(calls, ["validate", "record"]);
  assert.equal(result.validation.status, "blocked");
  assert.deepEqual(result.deliveries, []);
});

test("valid validation records evidence before routing", async () => {
  const calls = [];

  const result = await processPersistedEvent(
    { id: "evt_2", eventName: "landing.hero.exposed" },
    { ARCHIVE: {} },
    {
      validate() {
        calls.push("validate");
        return {
          status: "valid",
          schemaVersion: 1,
          contractId: "landing.hero.exposed@1",
          errors: [],
        };
      },
      async recordValidationState() {
        calls.push("record");
      },
      async route() {
        calls.push("route");
        return [{ destination: "posthog", status: "exported" }];
      },
    },
  );

  assert.deepEqual(calls, ["validate", "record", "route"]);
  assert.equal(result.validation.status, "valid");
  assert.equal(result.deliveries.length, 1);
});

test("unmanaged migration events continue routing", async () => {
  let routed = false;

  const result = await processPersistedEvent(
    { id: "evt_3", eventName: "legacy.smoke" },
    { ARCHIVE: {} },
    {
      validate() {
        return {
          status: "unmanaged",
          schemaVersion: null,
          contractId: null,
          errors: [],
        };
      },
      async recordValidationState() {},
      async route() {
        routed = true;
        return [];
      },
    },
  );

  assert.equal(result.validation.status, "unmanaged");
  assert.equal(routed, true);
});

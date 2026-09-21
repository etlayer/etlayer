import assert from "node:assert/strict";
import test from "node:test";

import { processPersistedEvent } from "../src/processing.js";

function privacyResult(event, deliveryActions = []) {
  return {
    event,
    policyVersion: 1,
    ingestActions: [],
    deliveryActions,
  };
}

function privacyState(status = "clean") {
  return {
    state: {
      version: 1,
      eventId: "evt",
      eventName: "example",
      policyVersion: 1,
      status,
      sourceKey: null,
      ingestActions: [],
      deliveryActions: [],
      updatedAt: "2026-09-22T01:00:00.000Z",
    },
  };
}

test("blocked validation records validation and privacy evidence but never routes", async () => {
  const calls = [];
  const event = { id: "evt_1", eventName: "account.created" };

  const result = await processPersistedEvent(
    event,
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
        calls.push("record-validation");
      },
      applyDeliveryPrivacy(receivedEvent) {
        calls.push("privacy");
        return privacyResult(receivedEvent);
      },
      async recordPrivacyState() {
        calls.push("record-privacy");
        return privacyState();
      },
      async route() {
        calls.push("route");
        return [];
      },
    },
  );

  assert.deepEqual(calls, [
    "validate",
    "record-validation",
    "privacy",
    "record-privacy",
  ]);
  assert.equal(result.validation.status, "blocked");
  assert.deepEqual(result.deliveries, []);
});

test("valid events route only the privacy-sanitized copy", async () => {
  const calls = [];
  const canonical = {
    id: "evt_2",
    eventName: "account.created",
    logRecord: {
      attributes: [
        { key: "account.id", value: { stringValue: "account_1" } },
        { key: "user.email", value: { stringValue: "person@example.test" } },
      ],
    },
  };
  const sanitized = {
    ...canonical,
    logRecord: {
      ...canonical.logRecord,
      attributes: [
        { key: "account.id", value: { stringValue: "account_1" } },
      ],
    },
  };

  const result = await processPersistedEvent(
    canonical,
    { ARCHIVE: {} },
    {
      validate() {
        calls.push("validate");
        return {
          status: "valid",
          schemaVersion: 1,
          contractId: "account.created@1",
          errors: [],
        };
      },
      async recordValidationState() {
        calls.push("record-validation");
      },
      applyDeliveryPrivacy(receivedEvent) {
        calls.push("privacy");
        assert.equal(receivedEvent, canonical);
        return privacyResult(sanitized, [
          {
            location: "logRecord",
            attribute: "user.email",
            classification: "direct_identifier",
            action: "drop",
          },
        ]);
      },
      async recordPrivacyState() {
        calls.push("record-privacy");
        return privacyState("applied");
      },
      async route(receivedEvent) {
        calls.push("route");
        assert.equal(receivedEvent, sanitized);
        assert.equal(
          receivedEvent.logRecord.attributes.some(
            ({ key }) => key === "user.email",
          ),
          false,
        );
        return [{ destination: "posthog", status: "exported" }];
      },
    },
  );

  assert.deepEqual(calls, [
    "validate",
    "record-validation",
    "privacy",
    "record-privacy",
    "route",
  ]);
  assert.equal(result.validation.status, "valid");
  assert.equal(result.deliveries.length, 1);
});

test("unmanaged migration events still receive privacy policy before routing", async () => {
  const calls = [];

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
      applyDeliveryPrivacy(event) {
        calls.push("privacy");
        return privacyResult(event);
      },
      async recordPrivacyState() {
        calls.push("record-privacy");
        return privacyState();
      },
      async route() {
        calls.push("route");
        return [];
      },
    },
  );

  assert.equal(result.validation.status, "unmanaged");
  assert.deepEqual(calls, ["privacy", "record-privacy", "route"]);
});

test("privacy evidence persistence failure remains retryable before routing", async () => {
  let routed = false;

  await assert.rejects(
    processPersistedEvent(
      { id: "evt_4", eventName: "legacy.smoke" },
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
        applyDeliveryPrivacy(event) {
          return privacyResult(event);
        },
        async recordPrivacyState() {
          throw new Error("privacy state unavailable");
        },
        async route() {
          routed = true;
          return [];
        },
      },
    ),
    /privacy state unavailable/,
  );

  assert.equal(routed, false);
});

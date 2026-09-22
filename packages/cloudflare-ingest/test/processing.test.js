import assert from "node:assert/strict";
import test from "node:test";

import { processPersistedEvent } from "../src/processing.js";

function authorityResult(status = "allowed") {
  return {
    status,
    profileId: "test",
    trustedProducerKind: "backend",
    claim: {
      producerKind: "backend",
      authorityKind: "business_state",
    },
    errors: [],
  };
}

function authorityState(authority) {
  return {
    state: {
      version: 1,
      eventId: "evt",
      eventName: "example",
      ...authority,
      sourceKey: null,
      updatedAt: "2026-09-22T01:00:00.000Z",
    },
  };
}

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
      version: 2,
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

function resolvedIdentity(event, overrides = {}) {
  return {
    status: "resolved",
    subject: {
      kind: "anonymous",
      id: "anon_1",
    },
    actor: {
      type: "anonymous",
      id: "anon_1",
      source: "inferred",
    },
    delegation: [],
    anonymousId: "anon_1",
    userId: null,
    accountId: null,
    sessionId: "session_1",
    transition: null,
    agent: {
      turnId: null,
      toolCallId: null,
    },
    attribution: {
      source: null,
      medium: null,
      campaign: null,
    },
    ...overrides,
  };
}

function identityState(identity) {
  return {
    state: {
      version: 1,
      eventId: "evt",
      eventName: "example",
      ...identity,
      sourceKey: null,
      updatedAt: "2026-09-22T01:00:00.000Z",
    },
  };
}

test("blocked validation records validation, privacy, and identity evidence but never routes", async () => {
  const calls = [];
  const event = {
    id: "evt_1",
    eventName: "account.created",
    logRecord: { attributes: [] },
  };

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
      evaluateAuthority() {
        calls.push("authority");
        return authorityResult();
      },
      async recordAuthorityState(_archive, _event, authority) {
        calls.push("record-authority");
        return authorityState(authority);
      },
      applyDeliveryPrivacy(receivedEvent) {
        calls.push("privacy");
        return privacyResult(receivedEvent);
      },
      async recordPrivacyState() {
        calls.push("record-privacy");
        return privacyState();
      },
      resolveIdentity(receivedEvent) {
        calls.push("identity");
        return resolvedIdentity(receivedEvent);
      },
      async recordIdentityState(_archive, _event, identity) {
        calls.push("record-identity");
        return identityState(identity);
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
    "authority",
    "record-authority",
    "privacy",
    "record-privacy",
    "identity",
    "record-identity",
  ]);
  assert.equal(result.validation.status, "blocked");
  assert.equal(result.identity.subject.id, "anon_1");
  assert.deepEqual(result.deliveries, []);
});

test("valid events route only the privacy-sanitized copy after identity evidence", async () => {
  const calls = [];
  const canonical = {
    id: "evt_2",
    eventName: "account.created",
    logRecord: {
      attributes: [
        { key: "user.id", value: { stringValue: "user_1" } },
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
        { key: "user.id", value: { stringValue: "user_1" } },
        { key: "account.id", value: { stringValue: "account_1" } },
      ],
    },
  };

  const identity = resolvedIdentity(sanitized, {
    subject: { kind: "user", id: "user_1" },
    actor: {
      type: "user",
      id: "user_1",
      source: "inferred",
    },
    userId: "user_1",
    accountId: "account_1",
  });

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
      evaluateAuthority() {
        calls.push("authority");
        return authorityResult();
      },
      async recordAuthorityState(_archive, _event, authority) {
        calls.push("record-authority");
        return authorityState(authority);
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
      resolveIdentity(receivedEvent) {
        calls.push("identity");
        assert.equal(receivedEvent, sanitized);
        return identity;
      },
      async recordIdentityState() {
        calls.push("record-identity");
        return identityState(identity);
      },
      async route(receivedEvent) {
        calls.push("route");
        assert.equal(receivedEvent, sanitized);
        return [{ destination: "posthog", status: "exported" }];
      },
    },
  );

  assert.deepEqual(calls, [
    "validate",
    "record-validation",
    "authority",
    "record-authority",
    "privacy",
    "record-privacy",
    "identity",
    "record-identity",
    "route",
  ]);
  assert.equal(result.identity.subject.id, "user_1");
  assert.equal(result.deliveries.length, 1);
});

test("identity evidence persistence failure remains retryable before routing", async () => {
  let routed = false;

  await assert.rejects(
    processPersistedEvent(
      {
        id: "evt_3",
        eventName: "legacy.smoke",
        logRecord: { attributes: [] },
      },
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
        evaluateAuthority() {
          return authorityResult();
        },
        async recordAuthorityState(_archive, _event, authority) {
          return authorityState(authority);
        },
        applyDeliveryPrivacy(event) {
          return privacyResult(event);
        },
        async recordPrivacyState() {
          return privacyState();
        },
        resolveIdentity(event) {
          return resolvedIdentity(event);
        },
        async recordIdentityState() {
          throw new Error("identity state unavailable");
        },
        async route() {
          routed = true;
          return [];
        },
      },
    ),
    /identity state unavailable/,
  );

  assert.equal(routed, false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  revalidateArchivedEvent,
  RevalidationNotFoundError,
  RevalidationValidationError,
} from "../src/revalidate.js";

function archivedEvent() {
  return {
    id: "evt_revalidate_1",
    eventName: "account.created",
    receivedAt: "2026-09-22T00:30:00.000Z",
    resource: {},
    scope: {},
    logRecord: {
      eventName: "account.created",
      attributes: [],
    },
  };
}

function archiveWith(event) {
  return {
    async put() {},
    async get(key) {
      if (
        key !==
        "events/2026/09/22/00/evt_revalidate_1.json"
      ) {
        return null;
      }

      return {
        async text() {
          return JSON.stringify(event);
        },
      };
    },
  };
}

test("revalidates a preserved event without producer involvement", async () => {
  const event = archivedEvent();
  const calls = [];

  const result = await revalidateArchivedEvent(
    { ARCHIVE: archiveWith(event) },
    {
      sourceKey:
        "events/2026/09/22/00/evt_revalidate_1.json",
    },
    {
      async process(receivedEvent, _env, options) {
        calls.push({ receivedEvent, options });
        return {
          validation: {
            status: "blocked",
            schemaVersion: 1,
            contractId: "account.created@1",
            errors: [
              {
                code: "required_attribute_missing",
                attribute: "account.id",
              },
            ],
          },
          deliveries: [],
        };
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].receivedEvent.id, event.id);
  assert.equal(
    calls[0].options.sourceKey,
    "events/2026/09/22/00/evt_revalidate_1.json",
  );
  assert.equal(result.eventId, event.id);
  assert.equal(result.validation.status, "blocked");
  assert.deepEqual(result.deliveries, []);
});

test("rejects source keys outside canonical events", async () => {
  await assert.rejects(
    () =>
      revalidateArchivedEvent(
        { ARCHIVE: archiveWith(archivedEvent()) },
        { sourceKey: "validation/evt.json" },
      ),
    RevalidationValidationError,
  );
});

test("reports a missing canonical event", async () => {
  await assert.rejects(
    () =>
      revalidateArchivedEvent(
        {
          ARCHIVE: {
            async get() {
              return null;
            },
          },
        },
        { sourceKey: "events/missing.json" },
      ),
    RevalidationNotFoundError,
  );
});

test("a corrected policy can route the preserved event", async () => {
  const event = archivedEvent();
  let routed = false;

  const result = await revalidateArchivedEvent(
    { ARCHIVE: archiveWith(event) },
    {
      sourceKey:
        "events/2026/09/22/00/evt_revalidate_1.json",
    },
    {
      validate() {
        return {
          status: "valid",
          schemaVersion: 1,
          contractId: "account.created@1",
          errors: [],
        };
      },
      async recordValidationState() {},
      async route() {
        routed = true;
        return [
          {
            destination: "posthog",
            status: "exported",
          },
        ];
      },
    },
  );

  assert.equal(routed, true);
  assert.equal(result.validation.status, "valid");
  assert.deepEqual(result.deliveries, [
    {
      destination: "posthog",
      status: "exported",
    },
  ]);
});


test("revalidation reapplies delivery privacy before routing the canonical event", async () => {
  const event = archivedEvent();
  event.logRecord.attributes = [
    {
      key: "user.email",
      value: { stringValue: "person@example.test" },
    },
    {
      key: "account.id",
      value: { stringValue: "account_1" },
    },
  ];

  let routedEvent;

  const result = await revalidateArchivedEvent(
    { ARCHIVE: archiveWith(event) },
    {
      sourceKey:
        "events/2026/09/22/00/evt_revalidate_1.json",
    },
    {
      validate() {
        return {
          status: "valid",
          schemaVersion: 1,
          contractId: "account.created@1",
          errors: [],
        };
      },
      async recordValidationState() {},
      async route(receivedEvent) {
        routedEvent = receivedEvent;
        return [
          {
            destination: "posthog",
            status: "exported",
          },
        ];
      },
    },
  );

  const keys = routedEvent.logRecord.attributes.map(
    ({ key }) => key,
  );

  assert.equal(keys.includes("user.email"), false);
  assert.equal(keys.includes("account.id"), true);
  assert.equal(result.validation.status, "valid");
});

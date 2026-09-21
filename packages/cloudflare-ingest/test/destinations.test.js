import assert from "node:assert/strict";
import test from "node:test";

import {
  DestinationRouterConfigurationError,
  routeEventDestinations,
} from "../src/destinations.js";

test("routes an event through configured destinations in order", async () => {
  const calls = [];
  const states = [];
  const event = { id: "evt_1", eventName: "account.created" };
  const env = { example: true };

  const results = await routeEventDestinations(event, env, {
    destinations: [
      {
        name: "first",
        async exportEvent(receivedEvent, receivedEnv, options) {
          calls.push(["first", receivedEvent, receivedEnv, options]);
          return { status: "exported", deliveryId: "one" };
        },
      },
      {
        name: "second",
        async exportEvent(receivedEvent, receivedEnv, options) {
          calls.push(["second", receivedEvent, receivedEnv, options]);
          return { status: "skipped", reason: "not_configured" };
        },
      },
    ],
    first: { marker: 1 },
    second: { marker: 2 },
    async recordState(_archive, receivedEvent, destination, result) {
      states.push({ receivedEvent, destination, result });
    },
  });

  assert.deepEqual(
    calls.map(([name, , , options]) => [name, options]),
    [
      ["first", { marker: 1 }],
      ["second", { marker: 2 }],
    ],
  );
  assert.equal(calls[0][1], event);
  assert.equal(calls[0][2], env);
  assert.deepEqual(
    states.map(({ destination, result }) => [
      destination,
      result.status,
    ]),
    [
      ["first", "exported"],
      ["second", "skipped"],
    ],
  );
  assert.deepEqual(results, [
    {
      destination: "first",
      status: "exported",
      deliveryId: "one",
    },
    {
      destination: "second",
      status: "skipped",
      reason: "not_configured",
    },
  ]);
});

test("a failed destination does not prevent another destination from being attempted", async () => {
  const calls = [];
  const states = [];

  const results = await routeEventDestinations(
    { id: "evt_1", eventName: "account.created" },
    {},
    {
      destinations: [
        {
          name: "posthog",
          async exportEvent() {
            calls.push("posthog");
            const error = new Error("destination failed");
            error.status = 503;
            throw error;
          },
        },
        {
          name: "statsig",
          async exportEvent() {
            calls.push("statsig");
            return { status: "exported" };
          },
        },
      ],
      async recordState(_archive, _event, destination, result) {
        states.push([destination, result.status]);
      },
    },
  );

  assert.deepEqual(calls, ["posthog", "statsig"]);
  assert.deepEqual(states, [
    ["posthog", "failed"],
    ["statsig", "exported"],
  ]);
  assert.equal(results[0].destination, "posthog");
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error.message, /destination failed/);
  assert.deepEqual(results[1], {
    destination: "statsig",
    status: "exported",
  });
});

test("delivery-state persistence failure remains retryable", async () => {
  await assert.rejects(
    routeEventDestinations(
      { id: "evt_1", eventName: "account.created" },
      {},
      {
        destinations: [
          {
            name: "posthog",
            async exportEvent() {
              return { status: "exported" };
            },
          },
        ],
        async recordState() {
          throw new Error("delivery state unavailable");
        },
      },
    ),
    /delivery state unavailable/,
  );
});

test("rejects malformed destination definitions", async () => {
  await assert.rejects(
    routeEventDestinations(
      { id: "evt_1", eventName: "account.created" },
      {},
      {
        destinations: [{ name: "", exportEvent: async () => ({}) }],
        async recordState() {},
      },
    ),
    DestinationRouterConfigurationError,
  );
});


test("already exported destination is not sent again", async () => {
  let exportCalls = 0;
  let stateWrites = 0;

  const results = await routeEventDestinations(
    { id: "evt_done", eventName: "account.created" },
    {},
    {
      destinations: [
        {
          name: "statsig",
          async exportEvent() {
            exportCalls += 1;
            return { status: "exported" };
          },
        },
      ],
      async readState(_archive, eventId, destination) {
        assert.equal(eventId, "evt_done");
        assert.equal(destination, "statsig");
        return {
          eventId,
          destination,
          status: "exported",
        };
      },
      async recordState() {
        stateWrites += 1;
      },
    },
  );

  assert.equal(exportCalls, 0);
  assert.equal(stateWrites, 0);
  assert.deepEqual(results, [
    {
      destination: "statsig",
      status: "skipped",
      reason: "already_exported",
    },
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  DestinationRouterConfigurationError,
  routeEventDestinations,
} from "../src/destinations.js";

test("routes an event through configured destinations in order", async () => {
  const calls = [];
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

test("preserves current fail-fast semantics until independent recovery exists", async () => {
  const calls = [];

  await assert.rejects(
    routeEventDestinations(
      { id: "evt_1", eventName: "account.created" },
      {},
      {
        destinations: [
          {
            name: "posthog",
            async exportEvent() {
              calls.push("posthog");
              throw new Error("destination failed");
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
      },
    ),
    /destination failed/,
  );

  assert.deepEqual(calls, ["posthog"]);
});

test("rejects malformed destination definitions", async () => {
  await assert.rejects(
    routeEventDestinations(
      { id: "evt_1", eventName: "account.created" },
      {},
      {
        destinations: [{ name: "", exportEvent: async () => ({}) }],
      },
    ),
    DestinationRouterConfigurationError,
  );
});

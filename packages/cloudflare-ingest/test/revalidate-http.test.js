import assert from "node:assert/strict";
import test from "node:test";

import { handleRevalidate } from "../src/revalidate-http.js";

function request(token = "operator-key", body = {}) {
  return new Request(
    "https://events.test/_ops/revalidate",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: "etlayer-default",
        sourceKey:
          "projects/etlayer-default/events/2026/09/22/00/evt_1.json",
        ...body,
      }),
    },
  );
}

test("rejects an invalid operator credential", async () => {
  let called = false;

  const response = await handleRevalidate(
    request("wrong"),
    { ETLAYER_REPLAY_KEY: "operator-key" },
    {
      revalidate: async () => {
        called = true;
        return {};
      },
    },
  );

  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("returns a revalidation result from canonical storage", async () => {
  const response = await handleRevalidate(
    request(),
    { ETLAYER_REPLAY_KEY: "operator-key" },
    {
      revalidate: async (_env, input) => ({
        sourceKey: input.sourceKey,
        eventId: "evt_1",
        eventName: "account.created",
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
      }),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.eventId, "evt_1");
  assert.equal(body.validation.status, "blocked");
  assert.deepEqual(body.deliveries, []);
});


test("default operator cannot revalidate a secondary project event", async () => {
  let called = false;

  const response = await handleRevalidate(
    request("operator-key", {
      projectId: "etlayer-secondary",
      sourceKey:
        "projects/etlayer-secondary/events/2026/09/22/00/evt_2.json",
    }),
    {
      ETLAYER_REPLAY_KEY: "operator-key",
      ETLAYER_SECONDARY_REPLAY_KEY: "secondary-key",
    },
    {
      revalidate: async () => {
        called = true;
        return {};
      },
    },
  );

  assert.equal(response.status, 401);
  assert.equal(called, false);
});

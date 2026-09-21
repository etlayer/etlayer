import assert from "node:assert/strict";
import test from "node:test";

import { handlePostHogReplay } from "../src/replay-http.js";

function request(token = "replay-key", body = {}) {
  return new Request("https://events.test/_ops/replay/posthog", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: "2026-09-21T18:35:00.000Z",
      to: "2026-09-21T18:40:00.000Z",
      replayId: "replay-http-test",
      ...body,
    }),
  });
}

test("rejects an invalid replay credential", async () => {
  let called = false;

  const response = await handlePostHogReplay(
    request("wrong"),
    { ETLAYER_REPLAY_KEY: "replay-key" },
    {
      replay: async () => {
        called = true;
        return {};
      },
    },
  );

  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("returns replay summary from the operator endpoint", async () => {
  const response = await handlePostHogReplay(
    request(),
    { ETLAYER_REPLAY_KEY: "replay-key" },
    {
      replay: async (_env, input) => ({
        replayId: input.replayId,
        from: input.from,
        to: input.to,
        selected: 2,
        exported: 2,
        deliveries: [],
      }),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.replayId, "replay-http-test");
  assert.equal(body.selected, 2);
  assert.equal(body.exported, 2);
});

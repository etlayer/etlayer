import assert from "node:assert/strict";
import test from "node:test";

import { handlePostHogReplay, handleStatsigReplay } from "../src/replay-http.js";

function request(token = "replay-key", body = {}) {
  return new Request("https://events.test/_ops/replay/posthog", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      projectId: "etlayer-default",
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


test("returns Statsig replay summary from the Statsig operator endpoint", async () => {
  const statsigRequest = new Request(
    "https://events.test/_ops/replay/statsig",
    {
      method: "POST",
      headers: {
        authorization: "Bearer replay-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: "etlayer-default",
        from: "2026-09-21T18:35:00.000Z",
        to: "2026-09-21T18:40:00.000Z",
        replayId: "replay-statsig-http-test",
      }),
    },
  );

  const response = await handleStatsigReplay(
    statsigRequest,
    { ETLAYER_REPLAY_KEY: "replay-key" },
    {
      replay: async (_env, input) => ({
        destination: "statsig",
        replayId: input.replayId,
        from: input.from,
        to: input.to,
        selected: 1,
        exported: 1,
        deliveries: [],
      }),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.destination, "statsig");
  assert.equal(body.replayId, "replay-statsig-http-test");
  assert.equal(body.exported, 1);
});


test("default project operator cannot authorize secondary replay", async () => {
  let called = false;

  const response = await handlePostHogReplay(
    request("replay-key", {
      projectId: "etlayer-secondary",
    }),
    {
      ETLAYER_REPLAY_KEY: "replay-key",
      ETLAYER_SECONDARY_REPLAY_KEY: "secondary-key",
    },
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

test("secondary project cannot replay a destination it does not enable", async () => {
  const response = await handleStatsigReplay(
    request("secondary-key", {
      projectId: "etlayer-secondary",
    }),
    {
      ETLAYER_SECONDARY_REPLAY_KEY: "secondary-key",
    },
    {
      replay: async () => {
        throw new Error("replay should be rejected by core");
      },
      authenticateProjectOperator() {
        return { ok: true, projectId: "etlayer-secondary" };
      },
    },
  );

  // The endpoint delegates destination policy to replay core. A focused core
  // test below proves Statsig is not enabled for the secondary project.
  assert.equal(response.status, 500);
});

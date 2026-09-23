import assert from "node:assert/strict";
import test from "node:test";

import { handleEvidenceRead } from "../src/evidence-http.js";

function request(token = "operator-key", body = {}) {
  return new Request(
    "https://events.test/_ops/evidence",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: "etlayer-default",
        key:
          "projects/etlayer-default/authority/evt_1.json",
        ...body,
      }),
    },
  );
}

test("returns exact project evidence for an authorized operator", async () => {
  const reads = [];
  const state = {
    version: 2,
    projectId: "etlayer-default",
    eventId: "evt_1",
    status: "blocked",
  };

  const response = await handleEvidenceRead(
    request(),
    {
      ETLAYER_REPLAY_KEY: "operator-key",
      ARCHIVE: {
        async get(key) {
          reads.push(key);
          return {
            httpMetadata: {
              contentType:
                "application/json; charset=utf-8",
            },
            async text() {
              return JSON.stringify(state);
            },
          };
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), state);
  assert.deepEqual(reads, [
    "projects/etlayer-default/authority/evt_1.json",
  ]);
});

test("returns 404 when project evidence does not exist", async () => {
  const response = await handleEvidenceRead(
    request(),
    {
      ETLAYER_REPLAY_KEY: "operator-key",
      ARCHIVE: {
        async get() {
          return null;
        },
      },
    },
  );

  assert.equal(response.status, 404);
});

test("rejects a cross-project key before reading archive", async () => {
  let read = false;

  const response = await handleEvidenceRead(
    request("operator-key", {
      key:
        "projects/etlayer-secondary/authority/evt_1.json",
    }),
    {
      ETLAYER_REPLAY_KEY: "operator-key",
      ARCHIVE: {
        async get() {
          read = true;
          return null;
        },
      },
    },
  );

  assert.equal(response.status, 400);
  assert.equal(read, false);
});

test("rejects an operator credential from another project", async () => {
  let read = false;

  const response = await handleEvidenceRead(
    request("operator-key", {
      projectId: "etlayer-secondary",
      key:
        "projects/etlayer-secondary/authority/evt_1.json",
    }),
    {
      ETLAYER_REPLAY_KEY: "operator-key",
      ETLAYER_SECONDARY_REPLAY_KEY: "secondary-key",
      ARCHIVE: {
        async get() {
          read = true;
          return null;
        },
      },
    },
  );

  assert.equal(response.status, 401);
  assert.equal(read, false);
});

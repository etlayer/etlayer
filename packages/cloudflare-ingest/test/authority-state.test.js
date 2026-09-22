import assert from "node:assert/strict";
import test from "node:test";

import {
  readAuthorityState,
  recordAuthorityState,
} from "../src/authority-state.js";

function archive() {
  const objects = new Map();

  return {
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      const body = objects.get(key);
      if (body == null) return null;
      return {
        async text() {
          return body;
        },
      };
    },
  };
}

test("records durable authority evidence without secrets", async () => {
  const store = archive();

  const result = await recordAuthorityState(
    store,
    {
      id: "evt_authority_1",
      eventName: "account.created",
    },
    {
      status: "blocked",
      policyVersion: 1,
      profileId: "agent-runtime",
      trustedProducerKind: "agent_runtime",
      claim: {
        producerKind: "backend",
        authorityKind: "business_state",
      },
      errors: [
        {
          code: "authority_not_allowed",
          authorityKind: "business_state",
        },
      ],
    },
    {
      sourceKey:
        "events/2026/09/22/01/evt_authority_1.json",
      now: new Date("2026-09-22T01:00:00.000Z"),
    },
  );

  assert.equal(
    result.key,
    "authority/evt_authority_1.json",
  );
  assert.equal(result.state.status, "blocked");
  assert.equal(result.state.profileId, "agent-runtime");
  assert.equal(
    JSON.stringify(result.state).includes("secret"),
    false,
  );

  const read = await readAuthorityState(
    store,
    "evt_authority_1",
  );
  assert.deepEqual(read, result.state);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  readIdentityState,
  recordIdentityState,
} from "../src/identity-state.js";

function archive() {
  const objects = new Map();

  return {
    objects,
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

test("records per-event identity evidence without building a graph", async () => {
  const store = archive();
  const result = await recordIdentityState(
    store,
    {
      id: "evt_identity_1",
      eventName: "identity.linked",
    },
    {
      status: "resolved",
      primary: { kind: "user", id: "user_1" },
      anonymousId: "anon_1",
      userId: "user_1",
      accountId: "account_1",
      sessionId: "session_1",
      transition: {
        kind: "anonymous_to_user",
        from: "anon_1",
        to: "user_1",
      },
      attribution: {
        source: "docs",
        medium: "acceptance",
        campaign: "vs5",
      },
    },
    {
      sourceKey: "events/2026/09/22/02/evt_identity_1.json",
      now: new Date("2026-09-22T02:01:00.000Z"),
    },
  );

  assert.equal(result.key, "identity/evt_identity_1.json");
  assert.equal(result.state.primary.id, "user_1");
  assert.equal(result.state.transition.kind, "anonymous_to_user");
  assert.equal(
    result.state.sourceKey,
    "events/2026/09/22/02/evt_identity_1.json",
  );

  const read = await readIdentityState(store, "evt_identity_1");
  assert.deepEqual(read, result.state);
});

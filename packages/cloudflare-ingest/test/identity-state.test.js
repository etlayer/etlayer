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

test("records subject actor and delegation without building a graph", async () => {
  const store = archive();
  const result = await recordIdentityState(
    store,
    {
      id: "evt_identity_1",
      eventName: "agent.tool.call",
    },
    {
      status: "resolved",
      subject: { kind: "user", id: "usr_42" },
      actor: {
        type: "agent",
        id: "agent_hanna",
        source: "explicit",
      },
      delegation: [
        {
          relationship: "on_behalf_of",
          principal: {
            type: "user",
            id: "usr_42",
          },
        },
      ],
      anonymousId: null,
      userId: "usr_42",
      accountId: "account_1",
      sessionId: "session_1",
      transition: null,
      agent: {
        turnId: "turn_17",
        toolCallId: "call_abc",
      },
      attribution: {
        source: "docs",
        medium: "acceptance",
        campaign: "vs5",
      },
    },
    {
      sourceKey: "projects/etlayer-default/events/2026/09/22/02/evt_identity_1.json",
      now: new Date("2026-09-22T02:01:00.000Z"),
    },
  );

  assert.equal(result.key, "projects/etlayer-default/identity/evt_identity_1.json");
  assert.equal(result.state.version, 3);
  assert.equal(result.state.projectId, "etlayer-default");
  assert.equal(result.state.subject.id, "usr_42");
  assert.equal(result.state.actor.id, "agent_hanna");
  assert.equal(result.state.delegation.length, 1);
  assert.equal(
    result.state.sourceKey,
    "projects/etlayer-default/events/2026/09/22/02/evt_identity_1.json",
  );

  const read = await readIdentityState(store, "evt_identity_1");
  assert.deepEqual(read, result.state);
});

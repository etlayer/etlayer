import assert from "node:assert/strict";
import test from "node:test";

import {
  readPrivacyState,
  recordPrivacyState,
} from "../src/privacy-state.js";

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
      return { async text() { return body; } };
    },
  };
}

test("records privacy actions without sensitive values", async () => {
  const store = archive();
  const event = {
    id: "evt_privacy_1",
    eventName: "account.created",
  };

  const result = await recordPrivacyState(
    store,
    event,
    {
      policyVersion: 1,
      ingestActions: [
        {
          location: "logRecord",
          attribute: "auth.token",
          classification: "secret",
          action: "drop",
        },
      ],
      deliveryActions: [
        {
          location: "logRecord",
          attribute: "user.email",
          classification: "direct_identifier",
          action: "drop",
        },
      ],
    },
    {
      sourceKey: "events/2026/09/22/00/evt_privacy_1.json",
      now: new Date("2026-09-22T01:00:00.000Z"),
    },
  );

  assert.equal(result.state.status, "applied");
  assert.equal(
    result.state.sourceKey,
    "events/2026/09/22/00/evt_privacy_1.json",
  );
  assert.equal(JSON.stringify(result.state).includes("secret-token"), false);

  const read = await readPrivacyState(store, "evt_privacy_1");
  assert.deepEqual(read, result.state);
});

test("records clean privacy state when no action is needed", async () => {
  const store = archive();

  const result = await recordPrivacyState(
    store,
    { id: "evt_clean", eventName: "legacy.smoke" },
    {
      policyVersion: 1,
      ingestActions: [],
      deliveryActions: [],
    },
  );

  assert.equal(result.state.status, "clean");
});

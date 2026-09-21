import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDeliveryPrivacy,
  applyIngestPrivacy,
} from "../src/privacy.js";

function attr(key, value) {
  return { key, value: { stringValue: value } };
}

function event() {
  return {
    id: "evt_privacy_1",
    eventName: "account.created",
    resource: {
      attributes: [
        attr("service.name", "fixture"),
        attr("authorization", "Bearer do-not-store"),
      ],
    },
    logRecord: {
      attributes: [
        attr("account.id", "account_1"),
        attr("user.email", "person@example.test"),
        attr("auth.token", "secret-token"),
      ],
    },
  };
}

function keys(attributes) {
  return attributes.map((item) => item.key);
}

test("ingest privacy removes secret values before queue/storage", () => {
  const result = applyIngestPrivacy(event());

  assert.deepEqual(keys(result.event.resource.attributes), ["service.name"]);
  assert.deepEqual(
    keys(result.event.logRecord.attributes),
    ["account.id", "user.email"],
  );

  assert.deepEqual(result.ingestActions, [
    {
      location: "resource",
      attribute: "authorization",
      classification: "secret",
      action: "drop",
    },
    {
      location: "logRecord",
      attribute: "auth.token",
      classification: "secret",
      action: "drop",
    },
  ]);

  assert.equal(
    JSON.stringify(result.event).includes("secret-token"),
    false,
  );
  assert.equal(
    JSON.stringify(result.event).includes("do-not-store"),
    false,
  );
});

test("delivery privacy removes direct identifiers and secrets defensively", () => {
  const ingest = applyIngestPrivacy(event());
  const result = applyDeliveryPrivacy(ingest.event);

  assert.deepEqual(
    keys(result.event.logRecord.attributes),
    ["account.id"],
  );
  assert.deepEqual(result.deliveryActions, [
    {
      location: "logRecord",
      attribute: "user.email",
      classification: "direct_identifier",
      action: "drop",
    },
  ]);
  assert.equal(result.ingestActions.length, 2);
});

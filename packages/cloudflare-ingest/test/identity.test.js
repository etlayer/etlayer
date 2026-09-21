import assert from "node:assert/strict";
import test from "node:test";

import {
  identityCustomIds,
  resolveEventIdentity,
} from "../src/identity.js";

function attr(key, value) {
  return { key, value: { stringValue: value } };
}

function event(eventName, attributes) {
  return {
    id: "evt_identity_1",
    eventName,
    receivedAt: "2026-09-22T02:00:00.000Z",
    logRecord: {
      attributes: Object.entries(attributes).map(([key, value]) =>
        attr(key, value),
      ),
    },
  };
}

test("anonymous event resolves the anonymous actor as primary", () => {
  const identity = resolveEventIdentity(
    event("landing.hero.exposed", {
      "actor.anonymous.id": "anon_1",
      "session.id": "session_1",
      "attribution.source": "docs",
      "attribution.medium": "acceptance",
      "attribution.campaign": "vs5",
    }),
  );

  assert.deepEqual(identity.primary, {
    kind: "anonymous",
    id: "anon_1",
  });
  assert.equal(identity.userId, null);
  assert.equal(identity.sessionId, "session_1");
  assert.deepEqual(identity.attribution, {
    source: "docs",
    medium: "acceptance",
    campaign: "vs5",
  });
});

test("identity.linked resolves user primary and anonymous-to-user transition", () => {
  const identity = resolveEventIdentity(
    event("identity.linked", {
      "actor.anonymous.id": "anon_1",
      "user.id": "user_1",
      "account.id": "account_1",
      "session.id": "session_1",
    }),
  );

  assert.deepEqual(identity.primary, {
    kind: "user",
    id: "user_1",
  });
  assert.deepEqual(identity.transition, {
    kind: "anonymous_to_user",
    from: "anon_1",
    to: "user_1",
  });
  assert.deepEqual(identityCustomIds(identity), {
    anonymousID: "anon_1",
    sessionID: "session_1",
    accountID: "account_1",
  });
});

test("identified account event keeps all known identity coordinates", () => {
  const identity = resolveEventIdentity(
    event("account.created", {
      "actor.anonymous.id": "anon_1",
      "user.id": "user_1",
      "account.id": "account_1",
      "session.id": "session_1",
    }),
  );

  assert.deepEqual(identity.primary, {
    kind: "user",
    id: "user_1",
  });
  assert.equal(identity.transition, null);
  assert.equal(identity.anonymousId, "anon_1");
  assert.equal(identity.accountId, "account_1");
  assert.equal(identity.sessionId, "session_1");
});

test("identity resolver has deterministic fallback for telemetry without identity", () => {
  const identity = resolveEventIdentity(
    event("etlayer.acceptance.fixture_preflight", {}),
  );

  assert.equal(identity.status, "fallback");
  assert.deepEqual(identity.primary, {
    kind: "event",
    id: "etlayer:evt_identity_1",
  });
});

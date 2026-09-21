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

test("anonymous browser event resolves anonymous subject and inferred actor", () => {
  const identity = resolveEventIdentity(
    event("landing.hero.exposed", {
      "actor.anonymous.id": "anon_1",
      "session.id": "session_1",
      "attribution.source": "docs",
      "attribution.medium": "acceptance",
      "attribution.campaign": "vs5",
    }),
  );

  assert.deepEqual(identity.subject, {
    kind: "anonymous",
    id: "anon_1",
  });
  assert.deepEqual(identity.actor, {
    type: "anonymous",
    id: "anon_1",
    source: "inferred",
  });
  assert.equal(identity.userId, null);
  assert.equal(identity.sessionId, "session_1");
  assert.deepEqual(identity.delegation, []);
});

test("identity.linked resolves user subject and anonymous-to-user transition", () => {
  const identity = resolveEventIdentity(
    event("identity.linked", {
      "actor.anonymous.id": "anon_1",
      "user.id": "user_1",
      "account.id": "account_1",
      "session.id": "session_1",
    }),
  );

  assert.deepEqual(identity.subject, {
    kind: "user",
    id: "user_1",
  });
  assert.deepEqual(identity.actor, {
    type: "user",
    id: "user_1",
    source: "inferred",
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

test("agent actor remains agent while analytics subject remains user", () => {
  const identity = resolveEventIdentity(
    event("agent.tool.call", {
      "actor.type": "agent",
      "actor.id": "agent_hanna",
      "user.id": "usr_42",
      "account.id": "account_1",
      "session.id": "session_1",
      "delegation.0.relationship": "on_behalf_of",
      "delegation.0.principal.type": "user",
      "delegation.0.principal.id": "usr_42",
      "agent.turn.id": "turn_17",
      "agent.tool_call.id": "call_abc",
    }),
  );

  assert.deepEqual(identity.subject, {
    kind: "user",
    id: "usr_42",
  });
  assert.deepEqual(identity.actor, {
    type: "agent",
    id: "agent_hanna",
    source: "explicit",
  });
  assert.deepEqual(identity.delegation, [
    {
      relationship: "on_behalf_of",
      principal: {
        type: "user",
        id: "usr_42",
      },
    },
  ]);
  assert.deepEqual(identity.agent, {
    turnId: "turn_17",
    toolCallId: "call_abc",
  });
  assert.deepEqual(identityCustomIds(identity), {
    sessionID: "session_1",
    accountID: "account_1",
    agentID: "agent_hanna",
  });
});

test("subagent preserves ordered delegation chain", () => {
  const identity = resolveEventIdentity(
    event("agent.subagent.tool.call", {
      "actor.type": "agent",
      "actor.id": "agent_child",
      "user.id": "usr_42",
      "account.id": "account_1",
      "session.id": "session_1",
      "delegation.0.relationship": "delegated_by",
      "delegation.0.principal.type": "agent",
      "delegation.0.principal.id": "agent_parent",
      "delegation.1.relationship": "on_behalf_of",
      "delegation.1.principal.type": "user",
      "delegation.1.principal.id": "usr_42",
    }),
  );

  assert.deepEqual(identity.subject, {
    kind: "user",
    id: "usr_42",
  });
  assert.equal(identity.actor.id, "agent_child");
  assert.deepEqual(identity.delegation, [
    {
      relationship: "delegated_by",
      principal: {
        type: "agent",
        id: "agent_parent",
      },
    },
    {
      relationship: "on_behalf_of",
      principal: {
        type: "user",
        id: "usr_42",
      },
    },
  ]);
});

test("explicit actor semantics do not depend on ID prefixes", () => {
  const identity = resolveEventIdentity(
    event("agent.tool.call", {
      "actor.type": "agent",
      "actor.id": "runtime-123",
      "user.id": "person-without-prefix",
    }),
  );

  assert.equal(identity.actor.type, "agent");
  assert.equal(identity.actor.id, "runtime-123");
  assert.equal(identity.subject.id, "person-without-prefix");
});

test("identity resolver rejects incomplete explicit actor", () => {
  assert.throws(
    () =>
      resolveEventIdentity(
        event("agent.tool.call", {
          "actor.type": "agent",
        }),
      ),
    /explicit actor requires/,
  );
});

test("identity resolver rejects incomplete delegation entries", () => {
  assert.throws(
    () =>
      resolveEventIdentity(
        event("agent.tool.call", {
          "actor.type": "agent",
          "actor.id": "agent_1",
          "delegation.0.relationship": "on_behalf_of",
        }),
      ),
    /delegation\.0 is incomplete or invalid/,
  );
});

test("identity resolver has deterministic fallback for telemetry without identity", () => {
  const identity = resolveEventIdentity(
    event("etlayer.acceptance.fixture_preflight", {}),
  );

  assert.equal(identity.status, "fallback");
  assert.deepEqual(identity.subject, {
    kind: "event",
    id: "etlayer:evt_identity_1",
  });
  assert.equal(identity.actor, null);
});

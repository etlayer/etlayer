import assert from "node:assert/strict";
import test from "node:test";

import { validateEventContract } from "../src/event-contracts.js";

function attribute(key, value) {
  if (typeof value === "string") {
    return { key, value: { stringValue: value } };
  }

  if (typeof value === "boolean") {
    return { key, value: { boolValue: value } };
  }

  if (Number.isSafeInteger(value)) {
    return { key, value: { intValue: String(value) } };
  }

  return { key, value: { doubleValue: value } };
}

function event(eventName, attributes) {
  return {
    id: "evt_1",
    eventName,
    receivedAt: "2026-09-22T00:00:00.000Z",
    resource: {},
    scope: {},
    logRecord: {
      eventName,
      attributes: Object.entries(attributes).map(([key, value]) =>
        attribute(key, value),
      ),
    },
  };
}

test("validates the reference hero exposure contract", () => {
  const result = validateEventContract(
    event("landing.hero.exposed", {
      "etlayer.schema.version": 1,
      "actor.anonymous.id": "anon_1",
      "correlation.id": "corr_1",
      "etlayer.producer.kind": "browser",
      "etlayer.authority.kind": "interaction",
      "experiment.id": "hero.v1",
      "experiment.variant": "fixture-a",
    }),
  );

  assert.deepEqual(result, {
    status: "valid",
    validatorVersion: 2,
    schemaVersion: 1,
    contractId: "landing.hero.exposed@1",
    errors: [],
  });
});

test("quarantines account.created when account.id is missing", () => {
  const result = validateEventContract(
    event("account.created", {
      "etlayer.schema.version": 1,
      "actor.anonymous.id": "anon_1",
      "correlation.id": "corr_1",
      "causation.id": "cause_1",
      "etlayer.producer.kind": "backend",
      "etlayer.authority.kind": "business_state",
    }),
  );

  assert.equal(result.status, "quarantined");
  assert.equal(result.contractId, "account.created@1");
  assert.deepEqual(result.errors, [
    {
      code: "required_attribute_missing",
      attribute: "account.id",
    },
  ]);
});

test("quarantines forbidden experiment context on account.created", () => {
  const result = validateEventContract(
    event("account.created", {
      "etlayer.schema.version": 1,
      "actor.anonymous.id": "anon_1",
      "account.id": "account_1",
      "correlation.id": "corr_1",
      "causation.id": "cause_1",
      "etlayer.producer.kind": "backend",
      "etlayer.authority.kind": "business_state",
      "experiment.id": "hero.v1",
      "experiment.variant": "fixture-a",
    }),
  );

  assert.equal(result.status, "quarantined");
  assert.deepEqual(result.errors, [
    {
      code: "forbidden_attribute_present",
      attribute: "experiment.id",
    },
    {
      code: "forbidden_attribute_present",
      attribute: "experiment.variant",
    },
  ]);
});

test("quarantines an authority mismatch with an exact machine-readable error", () => {
  const result = validateEventContract(
    event("account.created", {
      "etlayer.schema.version": 1,
      "actor.anonymous.id": "anon_1",
      "account.id": "account_1",
      "correlation.id": "corr_1",
      "causation.id": "cause_1",
      "etlayer.producer.kind": "backend",
      "etlayer.authority.kind": "interaction",
    }),
  );

  assert.equal(result.status, "quarantined");
  assert.deepEqual(result.errors, [
    {
      code: "attribute_value_mismatch",
      attribute: "etlayer.authority.kind",
      expected: "business_state",
      actual: "interaction",
    },
  ]);
});

test("treats unversioned events as unmanaged during migration", () => {
  const result = validateEventContract(
    event("legacy.smoke", {
      "correlation.id": "corr_1",
    }),
  );

  assert.deepEqual(result, {
    status: "unmanaged",
    validatorVersion: 2,
    schemaVersion: null,
    contractId: null,
    errors: [],
  });
});

test("quarantines a versioned event with no matching contract", () => {
  const result = validateEventContract(
    event("unknown.product.event", {
      "etlayer.schema.version": 1,
    }),
  );

  assert.deepEqual(result, {
    status: "quarantined",
    validatorVersion: 2,
    schemaVersion: 1,
    contractId: null,
    errors: [
      {
        code: "contract_not_found",
        eventName: "unknown.product.event",
        schemaVersion: 1,
      },
    ],
  });
});

test("validation is deterministic for repeated processing", () => {
  const managed = event("account.created", {
    "etlayer.schema.version": 1,
    "actor.anonymous.id": "anon_1",
    "correlation.id": "corr_1",
    "causation.id": "cause_1",
    "etlayer.producer.kind": "backend",
    "etlayer.authority.kind": "business_state",
  });

  assert.deepEqual(
    validateEventContract(managed),
    validateEventContract(managed),
  );
});


test("validates identity.linked@1 as a backend-authoritative transition", () => {
  const result = validateEventContract(
    event("identity.linked", {
      "etlayer.schema.version": 1,
      "actor.anonymous.id": "anon_1",
      "user.id": "user_1",
      "account.id": "account_1",
      "session.id": "session_1",
      "correlation.id": "corr_1",
      "causation.id": "cause_1",
      "etlayer.producer.kind": "backend",
      "etlayer.authority.kind": "business_state",
    }),
  );

  assert.deepEqual(result, {
    status: "valid",
    validatorVersion: 2,
    schemaVersion: 1,
    contractId: "identity.linked@1",
    errors: [],
  });
});


test("validates agent.tool.call@1 with explicit agent actor and user delegation", () => {
  const result = validateEventContract(
    event("agent.tool.call", {
      "etlayer.schema.version": 1,
      "actor.type": "agent",
      "actor.id": "agent_hanna",
      "user.id": "usr_42",
      "account.id": "account_1",
      "session.id": "session_1",
      "correlation.id": "corr_1",
      "causation.id": "cause_1",
      "delegation.0.relationship": "on_behalf_of",
      "delegation.0.principal.type": "user",
      "delegation.0.principal.id": "usr_42",
      "agent.turn.id": "turn_17",
      "agent.tool_call.id": "call_abc",
      "etlayer.producer.kind": "agent_runtime",
      "etlayer.authority.kind": "agent_runtime",
    }),
  );

  assert.deepEqual(result, {
    status: "valid",
    validatorVersion: 2,
    schemaVersion: 1,
    contractId: "agent.tool.call@1",
    errors: [],
  });
});

test("validates subagent delegation chain explicitly", () => {
  const result = validateEventContract(
    event("agent.subagent.tool.call", {
      "etlayer.schema.version": 1,
      "actor.type": "agent",
      "actor.id": "agent_child",
      "user.id": "usr_42",
      "account.id": "account_1",
      "session.id": "session_1",
      "correlation.id": "corr_1",
      "causation.id": "cause_1",
      "delegation.0.relationship": "delegated_by",
      "delegation.0.principal.type": "agent",
      "delegation.0.principal.id": "agent_parent",
      "delegation.1.relationship": "on_behalf_of",
      "delegation.1.principal.type": "user",
      "delegation.1.principal.id": "usr_42",
      "agent.turn.id": "turn_18",
      "agent.tool_call.id": "call_child",
      "etlayer.producer.kind": "agent_runtime",
      "etlayer.authority.kind": "agent_runtime",
    }),
  );

  assert.deepEqual(result, {
    status: "valid",
    validatorVersion: 2,
    schemaVersion: 1,
    contractId: "agent.subagent.tool.call@1",
    errors: [],
  });
});

test("deprecated published contract still validates and exposes lifecycle metadata", () => {
  const contract = {
    id: "account.created@2",
    eventName: "account.created",
    version: 2,
    required: {
      "account.id": {
        type: "string",
      },
    },
    forbidden: [],
  };

  const result = validateEventContract(
    event("account.created", {
      "etlayer.schema.version": 2,
      "account.id": "account_1",
    }),
    {
      findContract() {
        return contract;
      },
      contractStatus: "deprecated",
      governanceManifestDigest:
        "a".repeat(64),
    },
  );

  assert.equal(result.status, "valid");
  assert.equal(
    result.contractId,
    "account.created@2",
  );
  assert.equal(
    result.contractStatus,
    "deprecated",
  );
  assert.equal(
    result.governanceManifestDigest,
    "a".repeat(64),
  );
});

test("retired published contract quarantines without evaluating payload fields", () => {
  const contract = {
    id: "account.created@2",
    eventName: "account.created",
    version: 2,
    required: {
      "account.id": {
        type: "string",
      },
      "plan.id": {
        type: "string",
      },
    },
    forbidden: [],
  };

  const result = validateEventContract(
    event("account.created", {
      "etlayer.schema.version": 2,
      "account.id": "account_1",
      "plan.id": "pro",
    }),
    {
      findContract() {
        return contract;
      },
      contractStatus: "retired",
      governanceManifestDigest:
        "b".repeat(64),
    },
  );

  assert.equal(
    result.status,
    "quarantined",
  );
  assert.equal(
    result.contractId,
    "account.created@2",
  );
  assert.equal(
    result.contractStatus,
    "retired",
  );
  assert.deepEqual(result.errors, [
    {
      code: "contract_retired",
      eventName: "account.created",
      schemaVersion: 2,
    },
  ]);
});


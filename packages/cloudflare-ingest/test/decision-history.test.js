import assert from "node:assert/strict";
import test from "node:test";

import {
  decisionHistoryKey,
  latestDecisionKey,
  readDecisionHistory,
  readLatestDecisionPointer,
  recordDecisionHistory,
} from "../src/decision-history.js";

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

function evaluation({
  validationStatus = "valid",
  authorityStatus = "allowed",
} = {}) {
  return {
    validation: {
      status: validationStatus,
      validatorVersion: 1,
      schemaVersion: 1,
      contractId: "account.created@1",
      errors:
        validationStatus === "blocked"
          ? [{ code: "required_attribute_missing" }]
          : [],
    },
    authority: {
      status: authorityStatus,
      policyVersion: 1,
      profileId: "backend",
      trustedProducerKind: "backend",
      claim: {
        producerKind: "backend",
        authorityKind: "business_state",
      },
      errors:
        authorityStatus === "blocked"
          ? [{ code: "authority_not_allowed" }]
          : [],
    },
    privacy: {
      status: "clean",
      policyVersion: 1,
      ingestActions: [],
      deliveryActions: [],
    },
  };
}

test("records append-only decision evidence and advances only the latest pointer", async () => {
  const store = archive();
  const event = {
    id: "evt/decision",
    eventName: "account.created",
    provenance: {
      version: 1,
      profileId: "backend",
      producer: { kind: "backend" },
    },
  };

  const first = await recordDecisionHistory(
    store,
    event,
    evaluation(),
    {
      decisionId: "decision-1",
      evaluationKind: "processing",
      sourceKey: "events/2026/09/22/11/evt.json",
      now: new Date("2026-09-22T11:00:00.000Z"),
    },
  );

  const second = await recordDecisionHistory(
    store,
    event,
    evaluation({ authorityStatus: "blocked" }),
    {
      decisionId: "decision-2",
      evaluationKind: "revalidation",
      sourceKey: "events/2026/09/22/11/evt.json",
      now: new Date("2026-09-22T12:00:00.000Z"),
    },
  );

  assert.equal(
    first.key,
    "decisions/evt%2Fdecision/decision-1.json",
  );
  assert.equal(
    second.key,
    "decisions/evt%2Fdecision/decision-2.json",
  );

  const original = await readDecisionHistory(
    store,
    event.id,
    "decision-1",
  );
  const revalidation = await readDecisionHistory(
    store,
    event.id,
    "decision-2",
  );
  const latest = await readLatestDecisionPointer(
    store,
    event.id,
  );

  assert.equal(original.authority.status, "allowed");
  assert.equal(original.routeEligible, true);
  assert.equal(original.evaluationKind, "processing");

  assert.equal(revalidation.authority.status, "blocked");
  assert.equal(revalidation.routeEligible, false);
  assert.equal(revalidation.evaluationKind, "revalidation");

  assert.equal(latest.decisionId, "decision-2");
  assert.equal(latest.key, second.key);

  assert.equal(
    store.objects.has(
      "decisions/evt%2Fdecision/decision-1.json",
    ),
    true,
  );
  assert.equal(
    store.objects.has(
      "decisions/evt%2Fdecision/decision-2.json",
    ),
    true,
  );
});

test("decision evidence contains policy lineage but no credential material", async () => {
  const store = archive();

  const result = await recordDecisionHistory(
    store,
    {
      id: "evt_2",
      eventName: "account.created",
      provenance: {
        version: 1,
        profileId: "agent-runtime",
        producer: { kind: "agent_runtime" },
      },
    },
    evaluation({ authorityStatus: "blocked" }),
    {
      decisionId: "decision-safe",
      now: new Date("2026-09-22T11:10:00.000Z"),
    },
  );

  assert.equal(result.state.validation.validatorVersion, 1);
  assert.equal(result.state.authority.policyVersion, 1);
  assert.equal(result.state.privacy.policyVersion, 1);
  assert.equal(result.state.provenance.profileId, "agent-runtime");
  assert.equal(
    JSON.stringify(result.state).includes("Bearer "),
    false,
  );
  assert.equal(
    /secret|credential/i.test(
      JSON.stringify(Object.keys(result.state.provenance)),
    ),
    false,
  );
});

test("decision keys are deterministic for explicit ids", () => {
  assert.equal(
    decisionHistoryKey("event 1", "decision 1"),
    "decisions/event%201/decision%201.json",
  );
  assert.equal(
    latestDecisionKey("event 1"),
    "decision-latest/event%201.json",
  );
});

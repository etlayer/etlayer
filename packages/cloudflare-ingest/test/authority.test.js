import assert from "node:assert/strict";
import test from "node:test";

import { evaluateEventAuthority } from "../src/authority.js";

function attr(key, value) {
  return { key, value: { stringValue: value } };
}

function event({
  producerKind,
  authorityKind,
  provenance,
} = {}) {
  const attributes = [];

  if (producerKind) {
    attributes.push(attr("etlayer.producer.kind", producerKind));
  }

  if (authorityKind) {
    attributes.push(attr("etlayer.authority.kind", authorityKind));
  }

  return {
    id: "evt_authority_1",
    eventName: "account.created",
    provenance,
    logRecord: { attributes },
  };
}

const backend = {
  version: 1,
  profileId: "backend",
  authentication: "bearer_profile",
  producer: { kind: "backend" },
  allowedAuthorityKinds: ["business_state"],
};

const browser = {
  version: 1,
  profileId: "browser",
  authentication: "bearer_profile",
  producer: { kind: "browser" },
  allowedAuthorityKinds: ["interaction"],
};

const agent = {
  version: 1,
  profileId: "agent-runtime",
  authentication: "bearer_profile",
  producer: { kind: "agent_runtime" },
  allowedAuthorityKinds: ["agent_runtime"],
};

test("allows a claim matching trusted backend provenance", () => {
  const result = evaluateEventAuthority(
    event({
      producerKind: "backend",
      authorityKind: "business_state",
      provenance: backend,
    }),
  );

  assert.equal(result.status, "allowed");
  assert.equal(result.profileId, "backend");
  assert.deepEqual(result.errors, []);
});

test("blocks browser credential spoofing backend business authority", () => {
  const result = evaluateEventAuthority(
    event({
      producerKind: "backend",
      authorityKind: "business_state",
      provenance: browser,
    }),
  );

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.errors, [
    {
      code: "producer_kind_mismatch",
      claimed: "backend",
      trusted: "browser",
    },
    {
      code: "authority_not_allowed",
      authorityKind: "business_state",
    },
  ]);
});

test("blocks agent runtime spoofing backend business authority", () => {
  const result = evaluateEventAuthority(
    event({
      producerKind: "backend",
      authorityKind: "business_state",
      provenance: agent,
    }),
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.errors.length, 2);
});

test("allows agent runtime authority for agent-runtime facts", () => {
  const result = evaluateEventAuthority(
    event({
      producerKind: "agent_runtime",
      authorityKind: "agent_runtime",
      provenance: agent,
    }),
  );

  assert.equal(result.status, "allowed");
  assert.deepEqual(result.errors, []);
});

test("claims without trusted provenance are blocked", () => {
  const result = evaluateEventAuthority(
    event({
      producerKind: "backend",
      authorityKind: "business_state",
    }),
  );

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.errors, [
    { code: "trusted_provenance_missing" },
  ]);
});

test("telemetry without authority claims is not applicable", () => {
  const result = evaluateEventAuthority(event());

  assert.equal(result.status, "not_applicable");
  assert.deepEqual(result.errors, []);
});

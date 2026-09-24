import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeContractCompatibility,
  ContractCompatibilityError,
} from "../src/contract-compatibility.js";

function contract(overrides = {}) {
  return {
    id: "account.created@1",
    eventName: "account.created",
    version: 1,
    required: {
      "account.id": { type: "string" },
      "correlation.id": { type: "string" },
      "etlayer.producer.kind": {
        type: "string",
        const: "backend",
      },
    },
    forbidden: ["experiment.id"],
    ...overrides,
  };
}

test("removing a required attribute is backward-compatible but forward-breaking", () => {
  const current = contract();
  const proposed = contract({
    id: "account.created@2",
    version: 2,
    required: {
      "account.id": { type: "string" },
      "etlayer.producer.kind": {
        type: "string",
        const: "backend",
      },
    },
  });

  const backward =
    analyzeContractCompatibility(
      current,
      proposed,
      { mode: "backward" },
    );
  const forward =
    analyzeContractCompatibility(
      current,
      proposed,
      { mode: "forward" },
    );
  const full =
    analyzeContractCompatibility(
      current,
      proposed,
      { mode: "full" },
    );

  assert.equal(backward.compatible, true);
  assert.equal(forward.compatible, false);
  assert.equal(full.compatible, false);
  assert.deepEqual(
    forward.forward.violations,
    [
      {
        code: "required_attribute_removed",
        attribute: "correlation.id",
      },
    ],
  );
});

test("adding a required attribute is backward-breaking", () => {
  const result =
    analyzeContractCompatibility(
      contract(),
      contract({
        id: "account.created@2",
        version: 2,
        required: {
          ...contract().required,
          "plan.id": { type: "string" },
        },
      }),
      { mode: "backward" },
    );

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.backward.violations,
    [
      {
        code: "required_attribute_added",
        attribute: "plan.id",
      },
    ],
  );
});

test("adding a forbidden attribute is backward-breaking", () => {
  const result =
    analyzeContractCompatibility(
      contract(),
      contract({
        id: "account.created@2",
        version: 2,
        forbidden: [
          "experiment.id",
          "user.email",
        ],
      }),
      { mode: "backward" },
    );

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.backward.violations,
    [
      {
        code: "attribute_newly_forbidden",
        attribute: "user.email",
      },
    ],
  );
});

test("integer to number is a backward-compatible type relaxation", () => {
  const current = contract({
    required: {
      value: { type: "integer" },
    },
    forbidden: [],
  });
  const proposed = contract({
    id: "account.created@2",
    version: 2,
    required: {
      value: { type: "number" },
    },
    forbidden: [],
  });

  const result =
    analyzeContractCompatibility(
      current,
      proposed,
      { mode: "backward" },
    );

  assert.equal(result.compatible, true);
  assert.equal(result.forward.compatible, false);
});

test("adding or changing const narrows accepted values", () => {
  const current = contract({
    required: {
      kind: { type: "string" },
    },
    forbidden: [],
  });
  const proposed = contract({
    id: "account.created@2",
    version: 2,
    required: {
      kind: {
        type: "string",
        const: "backend",
      },
    },
    forbidden: [],
  });

  const result =
    analyzeContractCompatibility(
      current,
      proposed,
      { mode: "backward" },
    );

  assert.equal(result.compatible, false);
  assert.equal(
    result.backward.violations[0].code,
    "attribute_constraint_narrowed",
  );
  assert.equal(
    result.changes[0].backwardBreaking,
    true,
  );
});

test("a stable const remains compatible even when redundant type detail is removed", () => {
  const current = contract({
    required: {
      kind: {
        type: "string",
        const: "backend",
      },
    },
    forbidden: [],
  });
  const proposed = contract({
    id: "account.created@2",
    version: 2,
    required: {
      kind: {
        const: "backend",
      },
    },
    forbidden: [],
  });

  const result =
    analyzeContractCompatibility(
      current,
      proposed,
      { mode: "full" },
    );

  assert.equal(result.compatible, true);
});

test("rejects invalid comparison coordinates", () => {
  assert.throws(
    () =>
      analyzeContractCompatibility(
        contract(),
        contract({
          eventName: "invoice.paid",
          version: 2,
        }),
      ),
    ContractCompatibilityError,
  );

  assert.throws(
    () =>
      analyzeContractCompatibility(
        contract(),
        contract({ version: 1 }),
      ),
    /greater than current/,
  );
});

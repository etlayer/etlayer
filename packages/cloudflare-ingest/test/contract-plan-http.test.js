import assert from "node:assert/strict";
import test from "node:test";

import { handleContractPlan } from "../src/contract-plan-http.js";

function request(token, body) {
  return new Request(
    "https://events.test/_ops/plan/contract",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

test("operator-authenticated plan returns read-only analysis", async () => {
  let calls = 0;

  const response = await handleContractPlan(
    request("operator-a", {
      projectId: "project-a",
      eventName: "account.created",
      currentVersion: 1,
      proposedContract: {
        eventName: "account.created",
        version: 2,
        required: {},
        forbidden: [],
      },
      from: "2026-09-24T13:00:00Z",
      to: "2026-09-24T14:00:00Z",
    }),
    { ARCHIVE: {} },
    {
      async authenticateProjectOperator(
        _request,
        _env,
        projectId,
      ) {
        assert.equal(projectId, "project-a");
        return {
          ok: true,
          projectId,
          source: "registry",
        };
      },
      async planContractChange(_env, input) {
        calls += 1;
        assert.equal(input.projectId, "project-a");
        return {
          version: 1,
          selected: 3,
          changed: 1,
        };
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(await response.json(), {
    version: 1,
    selected: 3,
    changed: 1,
  });
});

test("cross-project operator denial prevents plan execution", async () => {
  let calls = 0;

  const response = await handleContractPlan(
    request("wrong", {
      projectId: "project-a",
    }),
    { ARCHIVE: {} },
    {
      async authenticateProjectOperator() {
        return {
          ok: false,
          reason: "invalid_operator_credential",
        };
      },
      async planContractChange() {
        calls += 1;
        return {};
      },
    },
  );

  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  handleGovernancePlan,
} from "../src/governance-plan-http.js";

function request(token, body) {
  return new Request(
    "https://events.test/_ops/plan/governance",
    {
      method: "POST",
      headers: {
        authorization:
          "Bearer " + token,
        "content-type":
          "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function manifest() {
  return {
    apiVersion: "etlayer.dev/v1",
    kind: "ProjectGovernance",
    projectId: "project-a",
    contracts: [
      {
        eventName:
          "account.created",
        currentVersion: 1,
        proposedContract: {
          eventName:
            "account.created",
          version: 2,
          required: {},
          forbidden: [],
        },
        from:
          "2026-09-25T10:00:00Z",
        to:
          "2026-09-25T11:00:00Z",
      },
    ],
  };
}

test("operator-authenticated governance plan returns deterministic analysis", async () => {
  let calls = 0;

  const response =
    await handleGovernancePlan(
      request(
        "operator-a",
        manifest(),
      ),
      { ARCHIVE: {} },
      {
        async authenticateProjectOperator(
          _request,
          _env,
          projectId,
        ) {
          assert.equal(
            projectId,
            "project-a",
          );
          return {
            ok: true,
            projectId,
            source: "registry",
          };
        },
        async planGovernanceManifest(
          _env,
          input,
        ) {
          calls += 1;
          assert.equal(
            input.projectId,
            "project-a",
          );
          return {
            version: 1,
            manifestDigest:
              "a".repeat(64),
            selected: 3,
            changed: 1,
          };
        },
      },
    );

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(
    await response.json(),
    {
      version: 1,
      manifestDigest:
        "a".repeat(64),
      selected: 3,
      changed: 1,
    },
  );
});

test("operator denial prevents governance plan execution", async () => {
  let calls = 0;

  const response =
    await handleGovernancePlan(
      request(
        "wrong",
        manifest(),
      ),
      { ARCHIVE: {} },
      {
        async authenticateProjectOperator() {
          return {
            ok: false,
            reason:
              "invalid_operator_credential",
          };
        },
        async planGovernanceManifest() {
          calls += 1;
          return {};
        },
      },
    );

  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

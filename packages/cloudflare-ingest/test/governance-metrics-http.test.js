import assert from "node:assert/strict";
import test from "node:test";

import {
  handleGovernanceMetrics,
} from "../src/governance-metrics-http.js";

function request(
  token,
  body,
) {
  return new Request(
    "https://events.test/_ops/governance/metrics",
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

test("project operator can read bounded governance metrics", async () => {
  let called = 0;

  const response =
    await handleGovernanceMetrics(
      request(
        "operator-a",
        {
          projectId:
            "project-a",
          from:
            "2026-09-26T10:00:00Z",
          to:
            "2026-09-26T11:00:00Z",
        },
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
        async buildGovernanceMetrics(
          _env,
          input,
        ) {
          called += 1;

          assert.equal(
            input.projectId,
            "project-a",
          );

          return {
            version: 1,
            projectId:
              "project-a",
            eventWindow: {
              selected: 2,
            },
            currentGovernance: {
              ownership: {
                resources: 1,
              },
            },
          };
        },
      },
    );

  assert.equal(
    response.status,
    200,
  );
  assert.equal(called, 1);
  assert.equal(
    (
      await response.json()
    ).eventWindow.selected,
    2,
  );
});

test("cross-project operator denial prevents metrics execution", async () => {
  let called = 0;

  const response =
    await handleGovernanceMetrics(
      request(
        "wrong",
        {
          projectId:
            "project-a",
          from:
            "2026-09-26T10:00:00Z",
          to:
            "2026-09-26T11:00:00Z",
        },
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
        async buildGovernanceMetrics() {
          called += 1;
          return {};
        },
      },
    );

  assert.equal(
    response.status,
    401,
  );
  assert.equal(called, 0);
});

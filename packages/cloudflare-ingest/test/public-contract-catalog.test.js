import assert from "node:assert/strict";
import test from "node:test";

import {
  handlePublicApiRequest,
} from "../src/public-api.js";

function catalogRequest(
  credential = "etl_op_project-a",
) {
  return new Request(
    "https://events.test/api/v1/projects/project-a/contracts",
    {
      method: "GET",
      headers: {
        authorization:
          `Bearer ${credential}`,
      },
    },
  );
}

test("public contract catalog returns explicitly selected supported fields", async () => {
  const response =
    await handlePublicApiRequest(
      catalogRequest(),
      {},
      undefined,
      {
        async authenticateProjectOperator() {
          return { ok: true };
        },
        async buildContractCatalog() {
          return {
            version: 1,
            apiVersion: "v1",
            kind: "ContractCatalog",
            projectId: "project-a",
            contracts: [
              {
                eventName:
                  "account.created",
                version: 1,
                source: "builtin",
                lifecycle: null,
                links: {
                  self:
                    "https://events.test/api/v1/projects/project-a/contracts/account.created/1",
                },
              },
            ],
            links: {
              self:
                "https://events.test/api/v1/projects/project-a/contracts",
              project:
                "https://events.test/api/v1/projects/project-a",
            },
            internalField:
              "must-not-leak",
          };
        },
      },
    );

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.deepEqual(body, {
    apiVersion: "v1",
    kind: "ContractCatalog",
    projectId: "project-a",
    contracts: [
      {
        eventName:
          "account.created",
        version: 1,
        source: "builtin",
        lifecycle: null,
        links: {
          self:
            "https://events.test/api/v1/projects/project-a/contracts/account.created/1",
        },
      },
    ],
    links: {
      self:
        "https://events.test/api/v1/projects/project-a/contracts",
      project:
        "https://events.test/api/v1/projects/project-a",
    },
  });
});

test("public contract catalog preserves project operator auth semantics", async () => {
  const denied =
    await handlePublicApiRequest(
      catalogRequest("wrong"),
      {},
      undefined,
      {
        async authenticateProjectOperator() {
          return {
            ok: false,
            reason: "invalid",
          };
        },
      },
    );

  assert.equal(denied.status, 401);
  assert.equal(
    (await denied.json()).error.code,
    "invalid_operator_credential",
  );

  const unknown =
    await handlePublicApiRequest(
      catalogRequest(),
      {},
      undefined,
      {
        async authenticateProjectOperator() {
          return {
            ok: false,
            reason: "unknown_project",
          };
        },
      },
    );

  assert.equal(unknown.status, 404);
  assert.equal(
    (await unknown.json()).error.code,
    "project_not_found",
  );
});

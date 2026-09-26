import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureContractLifecycle,
  transitionContractLifecycle,
} from "../src/contract-lifecycle.js";
import {
  governanceContractKey,
} from "../src/governance-publication.js";
import {
  handlePublicApiRequest,
} from "../src/public-api.js";
import {
  createRegistryProject,
  credentialFingerprint,
} from "../src/registry.js";

function archive() {
  const objects = new Map();

  return {
    objects,
    async put(key, body, options = {}) {
      objects.set(key, {
        body,
        customMetadata:
          options.customMetadata || {},
      });
      return { key };
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;

      return {
        async text() {
          return stored.body;
        },
      };
    },
  };
}

async function createProject(
  store,
  projectId,
  credential,
) {
  await createRegistryProject(
    store,
    {
      projectId,
      operatorFingerprint:
        await credentialFingerprint(
          credential,
        ),
      now: new Date(
        "2026-09-26T18:00:00Z",
      ),
    },
  );
}

function request(
  projectId,
  eventName,
  version,
  credential,
) {
  return new Request(
    `https://events.test/api/v1/projects/${projectId}/contracts/${eventName}/${version}`,
    {
      method: "GET",
      headers: {
        authorization:
          "Bearer " + credential,
      },
    },
  );
}

test("public contract artifact resolves project and builtin contracts without internals", async () => {
  const store = archive();

  await createProject(
    store,
    "project-a",
    "etl_op_project-a",
  );

  const digest = "a".repeat(64);

  await store.put(
    governanceContractKey(
      "project-a",
      "account.created",
      2,
    ),
    JSON.stringify({
      version: 1,
      projectId: "project-a",
      manifestDigest: digest,
      publishedAt:
        "2026-09-26T18:05:00.000Z",
      contract: {
        id: "account.created@2",
        eventName:
          "account.created",
        version: 2,
        required: {
          "account.id": {
            type: "string",
          },
          "plan.id": {
            type: "string",
          },
        },
        forbidden: [
          "experiment.id",
        ],
      },
    }),
  );

  await ensureContractLifecycle(
    store,
    {
      projectId: "project-a",
      eventName:
        "account.created",
      contractVersion: 2,
      contractId:
        "account.created@2",
      manifestDigest: digest,
      publishedAt:
        "2026-09-26T18:05:00.000Z",
    },
  );

  await transitionContractLifecycle(
    store,
    {
      projectId: "project-a",
      eventName:
        "account.created",
      contractVersion: 2,
      contractId:
        "account.created@2",
      manifestDigest: digest,
      publishedAt:
        "2026-09-26T18:05:00.000Z",
      toStatus: "deprecated",
    },
  );

  const projectResponse =
    await handlePublicApiRequest(
      request(
        "project-a",
        "account.created",
        2,
        "etl_op_project-a",
      ),
      { ARCHIVE: store },
    );

  assert.equal(
    projectResponse.status,
    200,
  );

  const projectArtifact =
    await projectResponse.json();

  assert.equal(
    projectArtifact.source,
    "project",
  );
  assert.equal(
    projectArtifact.lifecycle.status,
    "deprecated",
  );
  assert.equal(
    projectArtifact.lifecycle
      .manifestDigest,
    digest,
  );

  const builtinResponse =
    await handlePublicApiRequest(
      request(
        "project-a",
        "account.created",
        1,
        "etl_op_project-a",
      ),
      { ARCHIVE: store },
    );

  assert.equal(
    builtinResponse.status,
    200,
  );

  const builtin =
    await builtinResponse.json();

  assert.equal(
    builtin.source,
    "builtin",
  );
  assert.equal(
    builtin.lifecycle,
    null,
  );

  const serialized =
    JSON.stringify(
      projectArtifact,
    );

  assert.equal(
    serialized.includes("/_mgmt/"),
    false,
  );
  assert.equal(
    serialized.includes("/_ops/"),
    false,
  );
  assert.equal(
    serialized.includes(
      "credentialFingerprint",
    ),
    false,
  );
  assert.equal(
    serialized.includes(
      "operatorFingerprint",
    ),
    false,
  );
  assert.equal(
    serialized.includes(
      "registry/governance/",
    ),
    false,
  );
});

test("public contract artifact keeps project auth and stable 404 semantics", async () => {
  const store = archive();

  await createProject(
    store,
    "project-a",
    "etl_op_project-a",
  );
  await createProject(
    store,
    "project-b",
    "etl_op_project-b",
  );

  const denied =
    await handlePublicApiRequest(
      request(
        "project-a",
        "account.created",
        1,
        "etl_op_project-b",
      ),
      { ARCHIVE: store },
    );

  assert.equal(denied.status, 401);
  assert.equal(
    (await denied.json()).error
      .code,
    "invalid_operator_credential",
  );

  const missing =
    await handlePublicApiRequest(
      request(
        "project-a",
        "missing.event",
        9,
        "etl_op_project-a",
      ),
      { ARCHIVE: store },
    );

  assert.equal(missing.status, 404);
  assert.deepEqual(
    await missing.json(),
    {
      error: {
        code:
          "contract_not_found",
        message:
          "Contract not found",
      },
    },
  );
});

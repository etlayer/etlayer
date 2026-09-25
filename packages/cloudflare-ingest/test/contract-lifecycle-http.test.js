import assert from "node:assert/strict";
import test from "node:test";

import {
  controlPlaneAuditKey,
} from "../src/control-plane-audit.js";
import {
  governanceManifestDigest,
} from "../src/governance-manifest.js";
import {
  publishGovernanceManifest,
} from "../src/governance-publication.js";
import {
  readContractLifecycle,
} from "../src/contract-lifecycle.js";
import {
  handleManagementRequest,
} from "../src/management-http.js";

function fakeArchive() {
  const objects = new Map();

  return {
    objects,
    async put(key, body, options = {}) {
      if (
        options.onlyIf?.etagDoesNotMatch === "*" &&
        objects.has(key)
      ) {
        return null;
      }

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
    async list({ prefix = "" } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) =>
            key.startsWith(prefix),
          )
          .sort()
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}

function request(
  method,
  path,
  token,
  body = {},
) {
  return new Request(
    "https://events.test" + path,
    {
      method,
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

async function manage(
  env,
  method,
  path,
  token,
  body = {},
) {
  const incoming = request(
    method,
    path,
    token,
    body,
  );

  return handleManagementRequest(
    incoming,
    env,
    new URL(incoming.url),
  );
}

function manifest(projectId) {
  return {
    apiVersion: "etlayer.dev/v1",
    kind: "ProjectGovernance",
    projectId,
    contracts: [
      {
        eventName:
          "account.created",
        currentVersion: 1,
        compatibilityMode:
          "backward",
        proposedContract: {
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

test("project operator moves a published contract through audited monotonic lifecycle", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY:
      "management-key",
  };

  const projectResponse =
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "lifecycle-a" },
    );

  assert.equal(
    projectResponse.status,
    201,
  );

  const project =
    await projectResponse.json();
  const operator =
    project.operatorCredential;
  const governance =
    manifest("lifecycle-a");
  const digest =
    await governanceManifestDigest(
      governance,
    );

  await publishGovernanceManifest(
    archive,
    {
      manifest: governance,
      manifestDigest: digest,
      acknowledgeBreaking: true,
      plan: {
        version: 1,
        manifestDigest: digest,
        projectId: "lifecycle-a",
        compatible: false,
        selected: 1,
        changed: 1,
      },
    },
    {
      now: new Date(
        "2026-09-25T20:00:00Z",
      ),
    },
  );

  const before =
    await readContractLifecycle(
      archive,
      "lifecycle-a",
      "account.created",
      2,
    );

  assert.equal(
    before.status,
    "published",
  );

  const deprecated =
    await manage(
      env,
      "POST",
      "/_mgmt/projects/lifecycle-a/contracts/account.created/2/deprecate",
      operator,
      {},
    );

  assert.equal(
    deprecated.status,
    200,
  );

  const deprecateOperation =
    deprecated.headers.get(
      "x-etlayer-operation-id",
    );
  assert.ok(deprecateOperation);

  const deprecatedBody =
    await deprecated.json();

  assert.equal(
    deprecatedBody.changed,
    true,
  );
  assert.equal(
    deprecatedBody.contract.status,
    "deprecated",
  );

  const requested =
    await manage(
      env,
      "POST",
      "/_mgmt/evidence",
      "management-key",
      {
        key: controlPlaneAuditKey(
          deprecateOperation,
          "requested",
        ),
      },
    );

  assert.equal(requested.status, 200);
  const audit =
    await requested.json();

  assert.equal(
    audit.action,
    "contract.deprecate",
  );
  assert.equal(
    audit.actor.kind,
    "project_operator",
  );
  assert.equal(
    audit.target.kind,
    "contract",
  );
  assert.equal(
    audit.target.contractId,
    "account.created@2",
  );

  const repeatedDeprecate =
    await manage(
      env,
      "POST",
      "/_mgmt/projects/lifecycle-a/contracts/account.created/2/deprecate",
      operator,
      {},
    );

  assert.equal(
    repeatedDeprecate.status,
    200,
  );
  assert.equal(
    (await repeatedDeprecate.json())
      .changed,
    false,
  );

  const retired =
    await manage(
      env,
      "POST",
      "/_mgmt/projects/lifecycle-a/contracts/account.created/2/retire",
      operator,
      {},
    );

  assert.equal(retired.status, 200);
  assert.equal(
    (await retired.json())
      .contract.status,
    "retired",
  );

  const resurrection =
    await manage(
      env,
      "POST",
      "/_mgmt/projects/lifecycle-a/contracts/account.created/2/deprecate",
      operator,
      {},
    );

  assert.equal(
    resurrection.status,
    409,
  );

  const repeatedRetire =
    await manage(
      env,
      "POST",
      "/_mgmt/projects/lifecycle-a/contracts/account.created/2/retire",
      operator,
      {},
    );

  assert.equal(
    repeatedRetire.status,
    200,
  );
  assert.equal(
    (await repeatedRetire.json())
      .changed,
    false,
  );
});

test("published contract cannot skip directly to retired", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY:
      "management-key",
  };

  const project = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "lifecycle-b" },
    )
  ).json();

  const governance =
    manifest("lifecycle-b");
  const digest =
    await governanceManifestDigest(
      governance,
    );

  await publishGovernanceManifest(
    archive,
    {
      manifest: governance,
      manifestDigest: digest,
      acknowledgeBreaking: true,
      plan: {
        version: 1,
        manifestDigest: digest,
        projectId: "lifecycle-b",
        compatible: false,
        selected: 0,
        changed: 0,
      },
    },
  );

  const response = await manage(
    env,
    "POST",
    "/_mgmt/projects/lifecycle-b/contracts/account.created/2/retire",
    project.operatorCredential,
    {},
  );

  assert.equal(response.status, 409);

  const lifecycle =
    await readContractLifecycle(
      archive,
      "lifecycle-b",
      "account.created",
      2,
    );

  assert.equal(
    lifecycle.status,
    "published",
  );
});

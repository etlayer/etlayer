import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractArtifactNotFoundError,
  buildContractArtifact,
} from "../src/contract-artifact.js";
import {
  ensureContractLifecycle,
  transitionContractLifecycle,
} from "../src/contract-lifecycle.js";
import {
  governanceContractKey,
} from "../src/governance-publication.js";

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

test("resolves project-published contract artifact with lifecycle", async () => {
  const store = archive();
  const digest = "a".repeat(64);
  const contract = {
    id: "account.created@2",
    eventName: "account.created",
    version: 2,
    required: {
      "plan.id": {
        type: "string",
      },
      "account.id": {
        type: "string",
      },
    },
    forbidden: [
      "experiment.variant",
      "experiment.id",
    ],
  };

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
        "2026-09-26T18:00:00.000Z",
      contract,
    }),
  );

  await ensureContractLifecycle(
    store,
    {
      projectId: "project-a",
      eventName: "account.created",
      contractVersion: 2,
      contractId: "account.created@2",
      manifestDigest: digest,
      publishedAt:
        "2026-09-26T18:00:00.000Z",
    },
    {
      now: new Date(
        "2026-09-26T18:00:00Z",
      ),
    },
  );

  await transitionContractLifecycle(
    store,
    {
      projectId: "project-a",
      eventName: "account.created",
      contractVersion: 2,
      contractId: "account.created@2",
      manifestDigest: digest,
      publishedAt:
        "2026-09-26T18:00:00.000Z",
      toStatus: "deprecated",
    },
    {
      now: new Date(
        "2026-09-26T18:05:00Z",
      ),
    },
  );

  const result =
    await buildContractArtifact(
      { ARCHIVE: store },
      {
        projectId: "project-a",
        eventName: "account.created",
        version: 2,
        requestUrl:
          "https://events.test/api/v1/projects/project-a/contracts/account.created/2",
      },
    );

  assert.equal(result.source, "project");
  assert.deepEqual(
    Object.keys(
      result.contract.required,
    ),
    ["account.id", "plan.id"],
  );
  assert.deepEqual(
    result.contract.forbidden,
    [
      "experiment.id",
      "experiment.variant",
    ],
  );
  assert.deepEqual(
    result.lifecycle,
    {
      status: "deprecated",
      manifestDigest: digest,
      publishedAt:
        "2026-09-26T18:00:00.000Z",
    },
  );
  assert.deepEqual(
    result.links,
    {
      self:
        "https://events.test/api/v1/projects/project-a/contracts/account.created/2",
      project:
        "https://events.test/api/v1/projects/project-a",
    },
  );
});

test("falls back to exact builtin contract with no lifecycle", async () => {
  const result =
    await buildContractArtifact(
      { ARCHIVE: archive() },
      {
        projectId: "project-a",
        eventName: "account.created",
        version: 1,
        requestUrl:
          "https://events.test/api/v1/projects/project-a/contracts/account.created/1",
      },
    );

  assert.equal(result.source, "builtin");
  assert.equal(
    result.contract.id,
    "account.created@1",
  );
  assert.equal(result.lifecycle, null);
});

test("unknown exact contract is not found", async () => {
  await assert.rejects(
    () =>
      buildContractArtifact(
        { ARCHIVE: archive() },
        {
          projectId: "project-a",
          eventName: "missing.event",
          version: 99,
          requestUrl:
            "https://events.test/api/v1/projects/project-a/contracts/missing.event/99",
        },
      ),
    ContractArtifactNotFoundError,
  );
});

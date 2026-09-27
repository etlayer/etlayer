import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContractCatalog,
} from "../src/contract-catalog.js";
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

async function publishProjectContract(
  store,
  {
    projectId = "project-a",
    eventName,
    version,
    status = "published",
    digest = "a".repeat(64),
  },
) {
  const contract = {
    id: `${eventName}@${version}`,
    eventName,
    version,
    required: {
      "account.id": {
        type: "string",
      },
    },
    forbidden: [],
  };

  const publishedAt =
    "2026-09-27T03:00:00.000Z";

  await store.put(
    governanceContractKey(
      projectId,
      eventName,
      version,
    ),
    JSON.stringify({
      version: 1,
      projectId,
      manifestDigest: digest,
      publishedAt,
      contract,
    }),
  );

  await ensureContractLifecycle(
    store,
    {
      projectId,
      eventName,
      contractVersion: version,
      contractId: contract.id,
      manifestDigest: digest,
      publishedAt,
    },
    {
      now: new Date(publishedAt),
    },
  );

  if (status === "deprecated") {
    await transitionContractLifecycle(
      store,
      {
        projectId,
        eventName,
        contractVersion: version,
        toStatus: "deprecated",
      },
      {
        now: new Date(
          "2026-09-27T03:05:00.000Z",
        ),
      },
    );
  }

  return contract;
}

test("builds deterministic effective catalog from builtin and project contracts", async () => {
  const store = archive();

  await publishProjectContract(
    store,
    {
      eventName: "account.created",
      version: 2,
      status: "deprecated",
    },
  );

  const input = {
    projectId: "project-a",
    requestUrl:
      "https://events.test/api/v1/projects/project-a/contracts",
  };

  const first =
    await buildContractCatalog(
      { ARCHIVE: store },
      input,
    );
  const second =
    await buildContractCatalog(
      { ARCHIVE: store },
      input,
    );

  assert.equal(
    JSON.stringify(first),
    JSON.stringify(second),
  );

  assert.equal(
    first.apiVersion,
    "v1",
  );
  assert.equal(
    first.kind,
    "ContractCatalog",
  );
  assert.equal(
    first.projectId,
    "project-a",
  );

  const builtin =
    first.contracts.find(
      (item) =>
        item.eventName ===
          "account.created" &&
        item.version === 1,
    );
  const project =
    first.contracts.find(
      (item) =>
        item.eventName ===
          "account.created" &&
        item.version === 2,
    );

  assert.deepEqual(
    {
      source: builtin?.source,
      lifecycle:
        builtin?.lifecycle,
      self:
        builtin?.links?.self,
    },
    {
      source: "builtin",
      lifecycle: null,
      self:
        "https://events.test/api/v1/projects/project-a/contracts/account.created/1",
    },
  );

  assert.deepEqual(
    {
      source: project?.source,
      lifecycle:
        project?.lifecycle,
      self:
        project?.links?.self,
    },
    {
      source: "project",
      lifecycle: "deprecated",
      self:
        "https://events.test/api/v1/projects/project-a/contracts/account.created/2",
    },
  );

  const coordinates =
    first.contracts.map(
      (item) =>
        `${item.eventName}@${item.version}`,
    );
  const sorted = [...coordinates].sort(
    (left, right) => {
      const [leftEvent, leftVersion] =
        left.split("@");
      const [rightEvent, rightVersion] =
        right.split("@");
      const event =
        leftEvent.localeCompare(
          rightEvent,
        );

      return event !== 0
        ? event
        : Number(leftVersion) -
            Number(rightVersion);
    },
  );

  assert.deepEqual(
    coordinates,
    sorted,
  );
  assert.deepEqual(
    first.links,
    {
      self:
        "https://events.test/api/v1/projects/project-a/contracts",
      project:
        "https://events.test/api/v1/projects/project-a",
    },
  );
});

test("project exact coordinate overrides builtin coordinate", async () => {
  const store = archive();

  await publishProjectContract(
    store,
    {
      eventName: "account.created",
      version: 1,
    },
  );

  const result =
    await buildContractCatalog(
      { ARCHIVE: store },
      {
        projectId: "project-a",
        requestUrl:
          "https://events.test/api/v1/projects/project-a/contracts",
      },
    );

  const matches =
    result.contracts.filter(
      (item) =>
        item.eventName ===
          "account.created" &&
        item.version === 1,
    );

  assert.equal(matches.length, 1);
  assert.equal(
    matches[0].source,
    "project",
  );
  assert.equal(
    matches[0].lifecycle,
    "published",
  );
});

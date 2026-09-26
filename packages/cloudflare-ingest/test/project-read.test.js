import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureContractLifecycle,
  transitionContractLifecycle,
} from "../src/contract-lifecycle.js";
import {
  writeContractOwnership,
} from "../src/contract-ownership.js";
import {
  buildProjectReadModel,
} from "../src/project-read.js";
import {
  createRegistryProject,
  credentialFingerprint,
  setRegistryDestination,
} from "../src/registry.js";

function archive() {
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
    async list({
      prefix = "",
      cursor,
      limit = 1000,
    } = {}) {
      const keys = [...objects.keys()]
        .filter((key) =>
          key.startsWith(prefix),
        )
        .sort();

      const offset =
        cursor == null
          ? 0
          : Number(cursor);
      const page =
        keys.slice(
          offset,
          offset + limit,
        );
      const next =
        offset + page.length;

      return {
        objects:
          page.map(
            (key) => ({ key }),
          ),
        truncated:
          next < keys.length,
        cursor:
          next < keys.length
            ? String(next)
            : undefined,
      };
    },
  };
}

test("builds explicit non-secret project summary from authoritative state", async () => {
  const store = archive();
  const projectId = "customer-a";
  const operatorFingerprint =
    await credentialFingerprint(
      "etl_op_customer-a",
    );

  await createRegistryProject(
    store,
    {
      projectId,
      operatorFingerprint,
      now: new Date(
        "2026-09-26T17:00:00Z",
      ),
    },
  );

  await setRegistryDestination(
    store,
    {
      projectId,
      destination: "posthog",
      enabled: true,
      now: new Date(
        "2026-09-26T17:05:00Z",
      ),
    },
  );

  await writeContractOwnership(
    store,
    {
      projectId,
      eventName:
        "account.created",
      team: "accounts-platform",
      domain: "accounts",
      contacts: [],
    },
    {
      now: new Date(
        "2026-09-26T17:10:00Z",
      ),
    },
  );

  await ensureContractLifecycle(
    store,
    {
      projectId,
      eventName:
        "account.created",
      contractVersion: 2,
      contractId:
        "account.created@2",
      manifestDigest:
        "a".repeat(64),
      publishedAt:
        "2026-09-26T17:15:00Z",
    },
  );

  await transitionContractLifecycle(
    store,
    {
      projectId,
      eventName:
        "account.created",
      contractVersion: 2,
      contractId:
        "account.created@2",
      manifestDigest:
        "a".repeat(64),
      publishedAt:
        "2026-09-26T17:15:00Z",
      toStatus: "deprecated",
    },
    {
      now: new Date(
        "2026-09-26T17:20:00Z",
      ),
    },
  );

  const result =
    await buildProjectReadModel(
      { ARCHIVE: store },
      {
        projectId,
        requestUrl:
          "https://events.test/api/v1/projects/customer-a",
      },
    );

  assert.equal(result.version, 1);
  assert.deepEqual(result.project, {
    id: "customer-a",
    status: "active",
    source: "registry",
    createdAt:
      "2026-09-26T17:00:00.000Z",
    updatedAt:
      "2026-09-26T17:05:00.000Z",
  });
  assert.deepEqual(
    result.destinations,
    ["posthog"],
  );
  assert.deepEqual(
    result.governance,
    {
      ownership: {
        resources: 1,
        teams: [
          "accounts-platform",
        ],
        teamCount: 1,
      },
      lifecycle: {
        total: 1,
        published: 0,
        deprecated: 1,
        retired: 0,
      },
    },
  );
  assert.deepEqual(
    result.links,
    {
      self:
        "https://events.test/api/v1/projects/customer-a",
      onboarding:
        "https://events.test/api/v1/projects/customer-a/onboarding",
      eventStatusTemplate:
        "https://events.test/api/v1/projects/customer-a/events/{eventId}",
      ingest:
        "https://events.test/v1/logs",
    },
  );

  const serialized =
    JSON.stringify(result);

  assert.equal(
    serialized.includes(
      operatorFingerprint,
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
    serialized.includes("/_mgmt/"),
    false,
  );
  assert.equal(
    serialized.includes("/_ops/"),
    false,
  );
});

test("supports static compatibility project without exposing secret env names", async () => {
  const store = archive();

  const result =
    await buildProjectReadModel(
      { ARCHIVE: store },
      {
        projectId:
          "etlayer-default",
        requestUrl:
          "https://events.test/api/v1/projects/etlayer-default",
      },
    );

  assert.deepEqual(result.project, {
    id: "etlayer-default",
    status: "active",
    source: "static",
    createdAt: null,
    updatedAt: null,
  });
  assert.deepEqual(
    result.destinations,
    ["posthog", "statsig"],
  );

  const serialized =
    JSON.stringify(result);

  assert.equal(
    serialized.includes(
      "ETLAYER_REPLAY_KEY",
    ),
    false,
  );
  assert.equal(
    serialized.includes(
      "secretEnv",
    ),
    false,
  );
});

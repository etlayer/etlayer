import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractLifecycleTransitionError,
  contractLifecycleKey,
  ensureContractLifecycle,
  readContractLifecycle,
  transitionContractLifecycle,
} from "../src/contract-lifecycle.js";

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
  };
}

function identity() {
  return {
    projectId: "project-a",
    eventName: "account.created",
    contractVersion: 2,
    contractId: "account.created@2",
    manifestDigest: "a".repeat(64),
    publishedAt:
      "2026-09-25T20:00:00.000Z",
  };
}

test("publication initializes contract lifecycle as published", async () => {
  const store = archive();

  const result =
    await ensureContractLifecycle(
      store,
      identity(),
    );

  assert.equal(result.created, true);
  assert.equal(
    result.key,
    contractLifecycleKey(
      "project-a",
      "account.created",
      2,
    ),
  );
  assert.deepEqual(result.state, {
    version: 1,
    projectId: "project-a",
    eventName: "account.created",
    contractVersion: 2,
    contractId: "account.created@2",
    manifestDigest: "a".repeat(64),
    status: "published",
    publishedAt:
      "2026-09-25T20:00:00.000Z",
    updatedAt:
      "2026-09-25T20:00:00.000Z",
    deprecatedAt: null,
    retiredAt: null,
  });
});

test("lifecycle moves published to deprecated to retired", async () => {
  const store = archive();

  await ensureContractLifecycle(
    store,
    identity(),
  );

  const deprecated =
    await transitionContractLifecycle(
      store,
      {
        ...identity(),
        toStatus: "deprecated",
      },
      {
        now: new Date(
          "2026-09-25T20:10:00.000Z",
        ),
      },
    );

  assert.equal(deprecated.changed, true);
  assert.equal(
    deprecated.state.status,
    "deprecated",
  );
  assert.equal(
    deprecated.state.deprecatedAt,
    "2026-09-25T20:10:00.000Z",
  );

  const retired =
    await transitionContractLifecycle(
      store,
      {
        ...identity(),
        toStatus: "retired",
      },
      {
        now: new Date(
          "2026-09-25T20:20:00.000Z",
        ),
      },
    );

  assert.equal(retired.changed, true);
  assert.equal(
    retired.state.status,
    "retired",
  );
  assert.equal(
    retired.state.retiredAt,
    "2026-09-25T20:20:00.000Z",
  );

  const stored =
    await readContractLifecycle(
      store,
      "project-a",
      "account.created",
      2,
    );

  assert.equal(stored.status, "retired");
});

test("same lifecycle transition is idempotent", async () => {
  const store = archive();

  await ensureContractLifecycle(
    store,
    identity(),
  );

  const first =
    await transitionContractLifecycle(
      store,
      {
        ...identity(),
        toStatus: "deprecated",
      },
    );

  const second =
    await transitionContractLifecycle(
      store,
      {
        ...identity(),
        toStatus: "deprecated",
      },
    );

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(
    second.state.updatedAt,
    first.state.updatedAt,
  );
});

test("lifecycle rejects skipping deprecation and resurrection", async () => {
  const store = archive();

  await ensureContractLifecycle(
    store,
    identity(),
  );

  await assert.rejects(
    () =>
      transitionContractLifecycle(
        store,
        {
          ...identity(),
          toStatus: "retired",
        },
      ),
    ContractLifecycleTransitionError,
  );

  await transitionContractLifecycle(
    store,
    {
      ...identity(),
      toStatus: "deprecated",
    },
  );

  await transitionContractLifecycle(
    store,
    {
      ...identity(),
      toStatus: "retired",
    },
  );

  await assert.rejects(
    () =>
      transitionContractLifecycle(
        store,
        {
          ...identity(),
          toStatus: "deprecated",
        },
      ),
    ContractLifecycleTransitionError,
  );
});

test("pre-VS21 published contract can lazily materialize lifecycle", async () => {
  const store = archive();

  const result =
    await transitionContractLifecycle(
      store,
      {
        ...identity(),
        toStatus: "deprecated",
      },
      {
        now: new Date(
          "2026-09-25T20:10:00.000Z",
        ),
      },
    );

  assert.equal(result.changed, true);
  assert.equal(
    result.state.status,
    "deprecated",
  );
  assert.equal(
    result.state.publishedAt,
    "2026-09-25T20:00:00.000Z",
  );
});

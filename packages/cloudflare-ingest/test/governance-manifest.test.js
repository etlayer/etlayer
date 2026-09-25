import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalGovernanceManifestJson,
  governanceManifestDigest,
  normalizeGovernanceManifest,
} from "../src/governance-manifest.js";

function manifest(overrides = {}) {
  return {
    apiVersion: "etlayer.dev/v1",
    kind: "ProjectGovernance",
    projectId: "project-a",
    contracts: [
      {
        eventName: "account.created",
        currentVersion: 1,
        proposedContract: {
          id: "account.created@2",
          eventName: "account.created",
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
            "experiment.variant",
            "experiment.id",
          ],
        },
        from:
          "2026-09-25T10:00:00Z",
        to:
          "2026-09-25T11:00:00Z",
      },
    ],
    ...overrides,
  };
}

test("normalizes a ProjectGovernance manifest deterministically", () => {
  const normalized =
    normalizeGovernanceManifest(
      manifest(),
    );

  assert.equal(normalized.version, 1);
  assert.equal(
    normalized.contracts[0]
      .compatibilityMode,
    "backward",
  );
  assert.equal(
    normalized.contracts[0].maxEvents,
    500,
  );
  assert.equal(
    normalized.contracts[0].maxExamples,
    25,
  );
  assert.deepEqual(
    normalized.contracts[0]
      .proposedContract.forbidden,
    [
      "experiment.id",
      "experiment.variant",
    ],
  );

  assert.equal(
    canonicalGovernanceManifestJson(
      manifest(),
    ),
    canonicalGovernanceManifestJson(
      manifest(),
    ),
  );
});

test("semantically identical object and contract ordering has the same digest", async () => {
  const first = manifest({
    contracts: [
      {
        eventName: "landing.hero.exposed",
        currentVersion: 1,
        compatibilityMode: "backward",
        proposedContract: {
          eventName:
            "landing.hero.exposed",
          version: 2,
          required: {},
          forbidden: [],
        },
        from:
          "2026-09-25T10:00:00.000Z",
        to:
          "2026-09-25T11:00:00.000Z",
      },
      manifest().contracts[0],
    ],
  });

  const second = {
    kind: "ProjectGovernance",
    contracts: [
      {
        ...manifest().contracts[0],
        proposedContract: {
          forbidden: [
            "experiment.id",
            "experiment.variant",
          ],
          required: {
            "plan.id": {
              type: "string",
            },
            "account.id": {
              type: "string",
            },
          },
          version: 2,
          eventName: "account.created",
          id: "account.created@2",
        },
      },
      {
        to:
          "2026-09-25T11:00:00Z",
        from:
          "2026-09-25T10:00:00Z",
        proposedContract: {
          forbidden: [],
          required: {},
          version: 2,
          eventName:
            "landing.hero.exposed",
        },
        currentVersion: 1,
        eventName:
          "landing.hero.exposed",
      },
    ],
    projectId: "project-a",
    apiVersion: "etlayer.dev/v1",
  };

  assert.equal(
    await governanceManifestDigest(first),
    await governanceManifestDigest(second),
  );
});

test("rejects duplicate contract changes", () => {
  const one = manifest().contracts[0];

  assert.throws(
    () =>
      normalizeGovernanceManifest(
        manifest({
          contracts: [one, one],
        }),
      ),
    /duplicate contract change/,
  );
});

test("bounds aggregate historical planning work", () => {
  const first = manifest().contracts[0];
  const second = {
    ...first,
    eventName: "landing.hero.exposed",
    proposedContract: {
      eventName: "landing.hero.exposed",
      version: 2,
      required: {},
      forbidden: [],
    },
  };

  assert.throws(
    () =>
      normalizeGovernanceManifest(
        manifest({
          contracts: [
            {
              ...first,
              maxEvents: 3000,
            },
            {
              ...second,
              maxEvents: 3000,
            },
          ],
        }),
      ),
    /aggregate maxEvents/,
  );
});


import assert from "node:assert/strict";
import test from "node:test";

import { archiveKey } from "../src/archive.js";
import {
  checkGovernanceManifest,
  planGovernanceManifest,
} from "../src/governance-plan.js";

function attribute(key, value) {
  if (typeof value === "string") {
    return {
      key,
      value: { stringValue: value },
    };
  }

  return {
    key,
    value: { intValue: String(value) },
  };
}

function event({
  id,
  accountId = "account-1",
  planId,
  receivedAt,
}) {
  const attributes = [
    attribute("etlayer.schema.version", 1),
    attribute("actor.anonymous.id", "anon-1"),
    attribute("correlation.id", "corr-1"),
    attribute("causation.id", "cause-1"),
    attribute("etlayer.producer.kind", "backend"),
    attribute(
      "etlayer.authority.kind",
      "business_state",
    ),
  ];

  if (accountId != null) {
    attributes.push(
      attribute("account.id", accountId),
    );
  }

  if (planId != null) {
    attributes.push(
      attribute("plan.id", planId),
    );
  }

  return {
    id,
    eventName: "account.created",
    receivedAt,
    provenance: {
      version: 2,
      projectId: "governance-project",
      profileId: "backend",
      producer: { kind: "backend" },
      allowedAuthorityKinds: [
        "business_state",
      ],
    },
    logRecord: {
      eventName: "account.created",
      attributes,
    },
  };
}

function archive(events) {
  const objects = new Map(
    events.map((item) => [
      archiveKey(item),
      JSON.stringify(item),
    ]),
  );
  let writes = 0;

  return {
    get writes() {
      return writes;
    },
    async list({ prefix }) {
      return {
        objects: [...objects.keys()]
          .filter((key) =>
            key.startsWith(prefix),
          )
          .map((key) => ({ key })),
        truncated: false,
      };
    },
    async get(key) {
      const body = objects.get(key);
      if (!body) return null;

      return {
        async text() {
          return body;
        },
      };
    },
    async put() {
      writes += 1;
      throw new Error(
        "governance plan must be read-only",
      );
    },
  };
}

function governanceManifest() {
  return {
    apiVersion: "etlayer.dev/v1",
    kind: "ProjectGovernance",
    projectId: "governance-project",
    contracts: [
      {
        eventName: "account.created",
        currentVersion: 1,
        compatibilityMode: "backward",
        proposedContract: {
          id: "account.created@2",
          eventName: "account.created",
          version: 2,
          required: {
            "actor.anonymous.id": {
              type: "string",
            },
            "account.id": {
              type: "string",
            },
            "correlation.id": {
              type: "string",
            },
            "causation.id": {
              type: "string",
            },
            "plan.id": {
              type: "string",
            },
            "etlayer.producer.kind": {
              type: "string",
              const: "backend",
            },
            "etlayer.authority.kind": {
              type: "string",
              const: "business_state",
            },
          },
          forbidden: [
            "experiment.id",
            "experiment.variant",
          ],
        },
        from:
          "2026-09-25T10:00:00.000Z",
        to:
          "2026-09-25T10:01:00.000Z",
      },
    ],
  };
}

test("checks governance manifest compatibility without archive access", async () => {
  const result =
    await checkGovernanceManifest(
      governanceManifest(),
    );

  assert.match(
    result.manifestDigest,
    /^[0-9a-f]{64}$/,
  );
  assert.equal(result.compatible, false);
  assert.equal(
    result.contracts[0]
      .compatibility.backward.violations
      .some(
        (item) =>
          item.code ===
            "required_attribute_added" &&
          item.attribute === "plan.id",
      ),
    true,
  );
});

test("plans a governance manifest deterministically without writes", async () => {
  const store = archive([
    event({
      id: "evt-allow",
      planId: "pro",
      receivedAt:
        "2026-09-25T10:00:10.000Z",
    }),
    event({
      id: "evt-change",
      receivedAt:
        "2026-09-25T10:00:20.000Z",
    }),
  ]);

  const first =
    await planGovernanceManifest(
      { ARCHIVE: store },
      governanceManifest(),
    );
  const second =
    await planGovernanceManifest(
      { ARCHIVE: store },
      governanceManifest(),
    );

  assert.equal(
    first.manifestDigest,
    second.manifestDigest,
  );
  assert.equal(first.selected, 2);
  assert.equal(first.changed, 1);
  assert.deepEqual(
    first.contracts[0].transitions,
    {
      allow_to_allow: 1,
      allow_to_quarantine: 1,
    },
  );
  assert.equal(store.writes, 0);
});

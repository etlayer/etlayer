import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractOwnershipValidationError,
  contractOwnershipKey,
  normalizeContractOwnership,
  readContractOwnership,
  writeContractOwnership,
} from "../src/contract-ownership.js";

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

test("normalizes contract ownership deterministically", () => {
  const normalized =
    normalizeContractOwnership({
      projectId: "project-a",
      eventName: "account.created",
      team: "accounts-platform",
      domain: "accounts",
      contacts: [
        {
          kind: "slack",
          value: " #accounts-alerts ",
        },
        {
          kind: "email",
          value: "Accounts@Example.com",
        },
        {
          kind: "email",
          value: "accounts@example.com",
        },
        {
          kind: "url",
          value:
            "https://runbooks.example.com/accounts",
        },
      ],
    });

  assert.deepEqual(normalized, {
    version: 1,
    projectId: "project-a",
    eventName: "account.created",
    team: "accounts-platform",
    domain: "accounts",
    contacts: [
      {
        kind: "email",
        value: "accounts@example.com",
      },
      {
        kind: "slack",
        value: "#accounts-alerts",
      },
      {
        kind: "url",
        value:
          "https://runbooks.example.com/accounts",
      },
    ],
  });
});

test("ownership writes are idempotent after normalization", async () => {
  const store = archive();

  const first =
    await writeContractOwnership(
      store,
      {
        projectId: "project-a",
        eventName: "account.created",
        team: "accounts-platform",
        domain: "accounts",
        contacts: [
          {
            kind: "email",
            value:
              "accounts@example.com",
          },
          {
            kind: "slack",
            value: "#accounts-alerts",
          },
        ],
      },
      {
        now: new Date(
          "2026-09-25T21:00:00Z",
        ),
      },
    );

  assert.equal(first.changed, true);
  assert.equal(
    first.key,
    contractOwnershipKey(
      "project-a",
      "account.created",
    ),
  );

  const repeated =
    await writeContractOwnership(
      store,
      {
        projectId: "project-a",
        eventName: "account.created",
        team: "accounts-platform",
        domain: "accounts",
        contacts: [
          {
            kind: "slack",
            value: "#accounts-alerts",
          },
          {
            kind: "email",
            value:
              "Accounts@Example.com",
          },
          {
            kind: "email",
            value:
              "accounts@example.com",
          },
        ],
      },
      {
        now: new Date(
          "2026-09-25T21:05:00Z",
        ),
      },
    );

  assert.equal(
    repeated.changed,
    false,
  );
  assert.equal(
    repeated.state.updatedAt,
    "2026-09-25T21:00:00.000Z",
  );

  const changed =
    await writeContractOwnership(
      store,
      {
        projectId: "project-a",
        eventName: "account.created",
        team: "customer-platform",
        domain: "accounts",
        contacts: [
          {
            kind: "email",
            value:
              "accounts@example.com",
          },
        ],
      },
      {
        now: new Date(
          "2026-09-25T21:10:00Z",
        ),
      },
    );

  assert.equal(changed.changed, true);
  assert.equal(
    changed.state.team,
    "customer-platform",
  );

  const read =
    await readContractOwnership(
      store,
      "project-a",
      "account.created",
    );

  assert.deepEqual(
    read,
    changed.state,
  );
});

test("ownership rejects unsupported contact kinds", () => {
  assert.throws(
    () =>
      normalizeContractOwnership({
        projectId: "project-a",
        eventName: "account.created",
        team: "accounts-platform",
        contacts: [
          {
            kind: "pager",
            value: "primary",
          },
        ],
      }),
    ContractOwnershipValidationError,
  );
});

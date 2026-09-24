import assert from "node:assert/strict";
import test from "node:test";

import {
  auditEncryptionKeyUsage,
} from "../src/encryption-key-usage.js";

function fakeArchive(entries) {
  const objects = new Map(
    Object.entries(entries).map(([key, value]) => [
      key,
      JSON.stringify(value),
    ]),
  );

  return {
    async get(key) {
      const body = objects.get(key);
      if (body == null) return null;

      return {
        async text() {
          return body;
        },
      };
    },

    async list({ prefix, cursor }) {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();

      const offset = cursor
        ? Number(cursor)
        : 0;
      const page = keys.slice(offset, offset + 2);
      const next = offset + page.length;

      return {
        objects: page.map((key) => ({ key })),
        truncated: next < keys.length,
        ...(next < keys.length
          ? { cursor: String(next) }
          : {}),
      };
    },
  };
}

test("audits destination pointers and only unexpired idempotency capsules", async () => {
  const archive = fakeArchive({
    "registry/destination-credentials/project-a/posthog/current.json": {
      kind: "destination_credential_pointer",
      status: "active",
      keyVersion: "v1",
    },
    "registry/destination-credentials/project-a/posthog/versions/a.json": {
      kind: "destination_credential",
      keyVersion: "v1",
    },
    "registry/destination-credentials/project-b/posthog/current.json": {
      kind: "destination_credential_pointer",
      status: "active",
      keyVersion: "v2",
    },
    "registry/destination-credentials/project-c/posthog/current.json": {
      kind: "destination_credential_pointer",
      status: "disabled",
      keyVersion: "v1",
    },
    "registry/idempotency/project-a/onboarding-v1/a.json": {
      kind: "public_idempotency",
      status: "completed",
      keyVersion: "v1",
      replayUntil: "2026-09-24T12:00:00.000Z",
    },
    "registry/idempotency/project-a/onboarding-v1/b.json": {
      kind: "public_idempotency",
      status: "completed",
      keyVersion: "v1",
      replayUntil: "2026-09-24T08:00:00.000Z",
    },
    "registry/idempotency/project-b/onboarding-v1/c.json": {
      kind: "public_idempotency",
      status: "processing",
      keyVersion: "v2",
      replayUntil: "2026-09-24T13:00:00.000Z",
    },
  });

  const usage = await auditEncryptionKeyUsage(
    archive,
    {
      now: new Date("2026-09-24T10:00:00.000Z"),
    },
  );

  assert.deepEqual(
    usage.destination.versions.v1,
    {
      activePointers: 1,
      retirementSafe: false,
    },
  );
  assert.deepEqual(
    usage.destination.versions.v2,
    {
      activePointers: 1,
      retirementSafe: false,
    },
  );

  assert.deepEqual(
    usage.idempotency.versions.v1,
    {
      unexpiredCapsules: 1,
      retirementSafe: false,
    },
  );
  assert.deepEqual(
    usage.idempotency.versions.v2,
    {
      unexpiredCapsules: 1,
      retirementSafe: false,
    },
  );
});

test("reports root version retirement safe only when no still-required state depends on it", async () => {
  const archive = fakeArchive({
    "registry/destination-credentials/project-a/posthog/current.json": {
      kind: "destination_credential_pointer",
      status: "active",
      keyVersion: "v2",
    },
    "registry/idempotency/project-a/onboarding-v1/a.json": {
      kind: "public_idempotency",
      status: "completed",
      keyVersion: "v1",
      replayUntil: "2026-09-24T08:00:00.000Z",
    },
  });

  const usage = await auditEncryptionKeyUsage(
    archive,
    {
      now: new Date("2026-09-24T10:00:00.000Z"),
    },
  );

  assert.equal(
    usage.destination.versions.v1.retirementSafe,
    true,
  );
  assert.equal(
    usage.destination.versions.v2.retirementSafe,
    false,
  );
  assert.equal(
    usage.idempotency.versions.v1.retirementSafe,
    true,
  );
  assert.equal(
    usage.idempotency.versions.v2.retirementSafe,
    true,
  );
});

test("surfaces unknown active key versions rather than silently declaring everything safe", async () => {
  const archive = fakeArchive({
    "registry/destination-credentials/project-a/posthog/current.json": {
      kind: "destination_credential_pointer",
      status: "active",
      keyVersion: "v9",
    },
    "registry/idempotency/project-a/onboarding-v1/a.json": {
      kind: "public_idempotency",
      status: "completed",
      keyVersion: "legacy",
      replayUntil: "2026-09-24T12:00:00.000Z",
    },
  });

  const usage = await auditEncryptionKeyUsage(
    archive,
    {
      now: new Date("2026-09-24T10:00:00.000Z"),
    },
  );

  assert.equal(
    usage.destination.hasUnknownVersions,
    true,
  );
  assert.deepEqual(
    usage.destination.unknownVersions,
    { v9: 1 },
  );
  assert.equal(
    usage.idempotency.hasUnknownVersions,
    true,
  );
  assert.deepEqual(
    usage.idempotency.unknownVersions,
    { legacy: 1 },
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  DestinationCredentialDecryptionError,
  destinationCredentialCurrentKey,
  destinationCredentialVersionKey,
  disableDestinationCredential,
  readDestinationCredentialStatus,
  resolveDestinationCredential,
  writeDestinationCredential,
} from "../src/destination-credentials.js";

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
        httpMetadata: options.httpMetadata || {},
        customMetadata: options.customMetadata || {},
      });
      return { key };
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        httpMetadata: stored.httpMetadata,
        async text() {
          return stored.body;
        },
      };
    },
  };
}

const env = {
  ETLAYER_DESTINATION_SECRET_KEY_V1:
    "11".repeat(32),
  POSTHOG_PROJECT_TOKEN: "static-posthog",
};

test("encrypts identical secrets differently per project and resolves them", async () => {
  const archive = fakeArchive();
  const secret = "phc_same-provider-secret";

  const first = await writeDestinationCredential(
    archive,
    env,
    {
      projectId: "project-a",
      destination: "posthog",
      secret,
      credentialId: "credential-a",
      now: new Date("2026-09-23T12:00:00.000Z"),
    },
  );

  const second = await writeDestinationCredential(
    archive,
    env,
    {
      projectId: "project-b",
      destination: "posthog",
      secret,
      credentialId: "credential-b",
      now: new Date("2026-09-23T12:00:01.000Z"),
    },
  );

  assert.notEqual(
    first.record.ciphertext,
    second.record.ciphertext,
  );
  assert.notEqual(first.record.iv, second.record.iv);

  const resolvedA = await resolveDestinationCredential(
    archive,
    env,
    "project-a",
    "posthog",
  );
  const resolvedB = await resolveDestinationCredential(
    archive,
    env,
    "project-b",
    "posthog",
  );

  assert.equal(resolvedA.configured, true);
  assert.equal(resolvedA.source, "project_encrypted");
  assert.equal(resolvedA.secret, secret);
  assert.equal(resolvedB.secret, secret);

  const persisted = [...archive.objects.values()]
    .map(({ body }) => body)
    .join("\n");

  assert.equal(persisted.includes(secret), false);
});

test("rotation advances current pointer while old encrypted version remains", async () => {
  const archive = fakeArchive();

  await writeDestinationCredential(
    archive,
    env,
    {
      projectId: "project-a",
      destination: "posthog",
      secret: "old-secret",
      credentialId: "old-id",
      now: new Date("2026-09-23T12:10:00.000Z"),
    },
  );

  await writeDestinationCredential(
    archive,
    env,
    {
      projectId: "project-a",
      destination: "posthog",
      secret: "new-secret",
      credentialId: "new-id",
      now: new Date("2026-09-23T12:11:00.000Z"),
    },
  );

  assert.equal(
    archive.objects.has(
      destinationCredentialVersionKey(
        "project-a",
        "posthog",
        "old-id",
      ),
    ),
    true,
  );

  const pointer = JSON.parse(
    archive.objects.get(
      destinationCredentialCurrentKey(
        "project-a",
        "posthog",
      ),
    ).body,
  );

  assert.equal(pointer.credentialId, "new-id");
  assert.equal(pointer.status, "active");

  const resolved = await resolveDestinationCredential(
    archive,
    env,
    "project-a",
    "posthog",
  );

  assert.equal(resolved.secret, "new-secret");
  assert.equal(resolved.credentialId, "new-id");
});

test("disable preserves metadata but removes runtime secret availability", async () => {
  const archive = fakeArchive();

  await writeDestinationCredential(
    archive,
    env,
    {
      projectId: "project-a",
      destination: "posthog",
      secret: "provider-secret",
      credentialId: "credential-a",
      now: new Date("2026-09-23T12:20:00.000Z"),
    },
  );

  const disabled = await disableDestinationCredential(
    archive,
    {
      projectId: "project-a",
      destination: "posthog",
      now: new Date("2026-09-23T12:21:00.000Z"),
    },
  );

  assert.equal(disabled.status, "disabled");

  const resolved = await resolveDestinationCredential(
    archive,
    env,
    "project-a",
    "posthog",
  );

  assert.deepEqual(resolved, {
    configured: false,
    source: "project_encrypted",
    projectId: "project-a",
    destination: "posthog",
    credentialId: "credential-a",
    keyVersion: "v1",
    secret: null,
  });

  const status = await readDestinationCredentialStatus(
    archive,
    "project-a",
    "posthog",
  );

  assert.equal(status.configured, false);
  assert.equal(status.status, "disabled");
  assert.equal(status.credentialId, "credential-a");
  assert.equal("secret" in status, false);
  assert.equal("ciphertext" in status, false);
  assert.equal("iv" in status, false);
});

test("status for missing credential is redacted metadata only", async () => {
  const status = await readDestinationCredentialStatus(
    fakeArchive(),
    "project-a",
    "posthog",
  );

  assert.deepEqual(status, {
    configured: false,
    projectId: "project-a",
    destination: "posthog",
    status: "missing",
    credentialId: null,
    keyVersion: null,
    algorithm: null,
    createdAt: null,
    updatedAt: null,
  });
});

test("static reference project keeps Worker-secret compatibility", async () => {
  const resolved = await resolveDestinationCredential(
    fakeArchive(),
    env,
    "etlayer-default",
    "posthog",
  );

  assert.deepEqual(resolved, {
    configured: true,
    source: "worker_secret",
    projectId: "etlayer-default",
    destination: "posthog",
    credentialId: null,
    keyVersion: null,
    secret: "static-posthog",
  });
});

test("ciphertext cannot be transplanted to another project because AAD is scoped", async () => {
  const archive = fakeArchive();

  const written = await writeDestinationCredential(
    archive,
    env,
    {
      projectId: "project-a",
      destination: "posthog",
      secret: "provider-secret",
      credentialId: "credential-a",
    },
  );

  const transplantedVersionKey =
    destinationCredentialVersionKey(
      "project-b",
      "posthog",
      "credential-a",
    );

  archive.objects.set(transplantedVersionKey, {
    body: JSON.stringify({
      ...written.record,
      projectId: "project-b",
    }),
  });

  archive.objects.set(
    destinationCredentialCurrentKey(
      "project-b",
      "posthog",
    ),
    {
      body: JSON.stringify({
        ...written.pointer,
        projectId: "project-b",
        versionKey: transplantedVersionKey,
      }),
    },
  );

  await assert.rejects(
    resolveDestinationCredential(
      archive,
      env,
      "project-b",
      "posthog",
    ),
    DestinationCredentialDecryptionError,
  );
});

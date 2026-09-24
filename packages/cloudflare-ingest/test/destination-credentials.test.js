import assert from "node:assert/strict";
import test from "node:test";

import {
  DestinationCredentialDecryptionError,
  destinationCredentialCurrentKey,
  destinationCredentialVersionKey,
  disableDestinationCredential,
  readDestinationCredentialStatus,
  resolveDestinationCredential,
  rewrapDestinationCredential,
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


test("new destination writes can use v2 while historical v1 remains readable", async () => {
  const archive = fakeArchive();
  const versionedEnv = {
    ...env,
    ETLAYER_DESTINATION_SECRET_KEY_V2:
      "22".repeat(32),
  };

  const first = await writeDestinationCredential(
    archive,
    versionedEnv,
    {
      projectId: "project-v",
      destination: "posthog",
      secret: "provider-v1",
      credentialId: "credential-v1",
    },
  );

  assert.equal(first.record.keyVersion, "v1");

  const v2Env = {
    ...versionedEnv,
    ETLAYER_DESTINATION_SECRET_ACTIVE_VERSION: "v2",
  };

  const second = await writeDestinationCredential(
    archive,
    v2Env,
    {
      projectId: "project-v",
      destination: "statsig",
      secret: "provider-v2",
      credentialId: "credential-v2",
    },
  );

  assert.equal(second.record.keyVersion, "v2");

  const resolvedV2 = await resolveDestinationCredential(
    archive,
    v2Env,
    "project-v",
    "statsig",
  );
  assert.equal(resolvedV2.secret, "provider-v2");
  assert.equal(resolvedV2.keyVersion, "v2");

  archive.objects.set(
    destinationCredentialCurrentKey(
      "project-v",
      "posthog",
    ),
    {
      body: JSON.stringify(first.pointer),
    },
  );

  const resolvedV1 = await resolveDestinationCredential(
    archive,
    v2Env,
    "project-v",
    "posthog",
  );

  assert.equal(resolvedV1.secret, "provider-v1");
  assert.equal(resolvedV1.keyVersion, "v1");
});

test("historical v1 destination state fails clearly when v1 root is missing", async () => {
  const archive = fakeArchive();
  const versionedEnv = {
    ...env,
    ETLAYER_DESTINATION_SECRET_KEY_V2:
      "22".repeat(32),
  };

  await writeDestinationCredential(
    archive,
    versionedEnv,
    {
      projectId: "project-missing-root",
      destination: "posthog",
      secret: "provider-v1",
      credentialId: "credential-v1",
    },
  );

  await assert.rejects(
    resolveDestinationCredential(
      archive,
      {
        ETLAYER_DESTINATION_SECRET_KEY_V2:
          "22".repeat(32),
        ETLAYER_DESTINATION_SECRET_ACTIVE_VERSION:
          "v2",
      },
      "project-missing-root",
      "posthog",
    ),
    /ETLAYER_DESTINATION_SECRET_KEY_V1 is required/,
  );
});


test("rewrap appends a v2 encrypted version and preserves the provider secret", async () => {
  const archive = fakeArchive();
  const versionedEnv = {
    ...env,
    ETLAYER_DESTINATION_SECRET_KEY_V2:
      "22".repeat(32),
  };

  const original = await writeDestinationCredential(
    archive,
    versionedEnv,
    {
      projectId: "project-rewrap",
      destination: "posthog",
      secret: "same-provider-secret",
      credentialId: "credential-v1",
      now: new Date("2026-09-24T03:00:00.000Z"),
    },
  );

  const originalBody =
    archive.objects.get(
      original.pointer.versionKey,
    ).body;

  const result = await rewrapDestinationCredential(
    archive,
    versionedEnv,
    {
      projectId: "project-rewrap",
      destination: "posthog",
      targetKeyVersion: "v2",
      now: new Date("2026-09-24T03:01:00.000Z"),
    },
  );

  assert.equal(result.rewrapped, true);
  assert.equal(
    result.previousPointer.credentialId,
    "credential-v1",
  );
  assert.equal(result.pointer.keyVersion, "v2");
  assert.notEqual(
    result.pointer.credentialId,
    "credential-v1",
  );
  assert.equal(
    result.record.rotationKind,
    "master_key_rewrap",
  );
  assert.equal(
    result.record.supersedesCredentialId,
    "credential-v1",
  );

  assert.equal(
    archive.objects.get(
      original.pointer.versionKey,
    ).body,
    originalBody,
  );

  const resolved = await resolveDestinationCredential(
    archive,
    versionedEnv,
    "project-rewrap",
    "posthog",
  );

  assert.equal(
    resolved.secret,
    "same-provider-secret",
  );
  assert.equal(resolved.keyVersion, "v2");
});

test("rewrap is a no-op when current credential already uses the target root", async () => {
  const archive = fakeArchive();
  const versionedEnv = {
    ...env,
    ETLAYER_DESTINATION_SECRET_KEY_V2:
      "22".repeat(32),
    ETLAYER_DESTINATION_SECRET_ACTIVE_VERSION:
      "v2",
  };

  const written = await writeDestinationCredential(
    archive,
    versionedEnv,
    {
      projectId: "project-noop",
      destination: "posthog",
      secret: "provider-secret",
      credentialId: "credential-v2",
    },
  );

  const keysBefore = [...archive.objects.keys()];

  const result = await rewrapDestinationCredential(
    archive,
    versionedEnv,
    {
      projectId: "project-noop",
      destination: "posthog",
      targetKeyVersion: "v2",
    },
  );

  assert.equal(result.rewrapped, false);
  assert.equal(
    result.pointer.credentialId,
    written.pointer.credentialId,
  );
  assert.deepEqual(
    [...archive.objects.keys()],
    keysBefore,
  );
});

test("rewrap does not advance the pointer when the target root is unavailable", async () => {
  const archive = fakeArchive();

  const written = await writeDestinationCredential(
    archive,
    env,
    {
      projectId: "project-rewrap-failure",
      destination: "posthog",
      secret: "provider-secret",
      credentialId: "credential-v1",
    },
  );

  await assert.rejects(
    rewrapDestinationCredential(
      archive,
      env,
      {
        projectId: "project-rewrap-failure",
        destination: "posthog",
        targetKeyVersion: "v2",
      },
    ),
    /ETLAYER_DESTINATION_SECRET_KEY_V2 is required/,
  );

  const status = await readDestinationCredentialStatus(
    archive,
    "project-rewrap-failure",
    "posthog",
  );

  assert.equal(
    status.credentialId,
    written.pointer.credentialId,
  );
  assert.equal(status.keyVersion, "v1");
});


test("rewrapped destination remains usable when v1 root is omitted", async () => {
  const archive = fakeArchive();
  const bothRoots = {
    ...env,
    ETLAYER_DESTINATION_SECRET_KEY_V2:
      "22".repeat(32),
  };

  await writeDestinationCredential(
    archive,
    bothRoots,
    {
      projectId: "project-retired-v1",
      destination: "posthog",
      secret: "provider-secret",
      credentialId: "credential-v1",
    },
  );

  await rewrapDestinationCredential(
    archive,
    bothRoots,
    {
      projectId: "project-retired-v1",
      destination: "posthog",
      targetKeyVersion: "v2",
    },
  );

  const resolved = await resolveDestinationCredential(
    archive,
    {
      ETLAYER_DESTINATION_SECRET_KEY_V2:
        "22".repeat(32),
      ETLAYER_DESTINATION_SECRET_ACTIVE_VERSION:
        "v2",
      POSTHOG_PROJECT_TOKEN: "static-posthog",
    },
    "project-retired-v1",
    "posthog",
  );

  assert.equal(resolved.keyVersion, "v2");
  assert.equal(resolved.secret, "provider-secret");
});

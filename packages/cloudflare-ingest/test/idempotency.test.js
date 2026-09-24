import assert from "node:assert/strict";
import test from "node:test";

import {
  IdempotencyKeyExpiredError,
  IdempotencyKeyReusedError,
  beginIdempotentOperation,
  completeIdempotentOperation,
  fingerprintSemanticRequest,
  idempotencyRecordKey,
} from "../src/idempotency.js";

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
  ETLAYER_IDEMPOTENCY_SECRET_KEY_V1:
    "22".repeat(32),
};

test("stores recovery payload encrypted and replays completed response", async () => {
  const archive = fakeArchive();
  const requestFingerprint =
    await fingerprintSemanticRequest({
      operation: "onboarding.v1",
      projectId: "customer-a",
      producerId: "backend-main",
      destinations: ["posthog"],
    });

  const first = await beginIdempotentOperation(
    archive,
    env,
    {
      projectId: "customer-a",
      operation: "onboarding-v1",
      idempotencyKey: "request-123",
      requestFingerprint,
      recoveryPayload: {
        credential: "etl_prod_plaintext-secret",
      },
      now: new Date("2026-09-24T00:00:00.000Z"),
    },
  );

  assert.equal(first.replayed, false);
  assert.equal(
    first.payload.credential,
    "etl_prod_plaintext-secret",
  );

  const persistedBefore = [
    ...archive.objects.values(),
  ]
    .map(({ body }) => body)
    .join("\n");

  assert.equal(
    persistedBefore.includes(
      "etl_prod_plaintext-secret",
    ),
    false,
  );
  assert.equal(
    persistedBefore.includes("request-123"),
    false,
  );

  const responsePayload = {
    apiVersion: "v1",
    projectId: "customer-a",
    credential: "etl_prod_plaintext-secret",
  };

  await completeIdempotentOperation(
    archive,
    env,
    {
      key: first.key,
      record: {
        ...first.record,
        statusCode: 201,
      },
      responsePayload,
      now: new Date("2026-09-24T00:00:01.000Z"),
    },
  );

  const replay = await beginIdempotentOperation(
    archive,
    env,
    {
      projectId: "customer-a",
      operation: "onboarding-v1",
      idempotencyKey: "request-123",
      requestFingerprint,
      recoveryPayload: {
        credential: "unused-new-secret",
      },
      now: new Date("2026-09-24T00:00:02.000Z"),
    },
  );

  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.payload, responsePayload);
  assert.equal(replay.record.statusCode, 201);

  const stored = [
    ...archive.objects.values(),
  ]
    .map(({ body }) => body)
    .join("\n");

  assert.equal(
    stored.includes("etl_prod_plaintext-secret"),
    false,
  );
  assert.equal(stored.includes("request-123"), false);
});

test("same key with different semantic request is rejected", async () => {
  const archive = fakeArchive();
  const firstFingerprint =
    await fingerprintSemanticRequest({
      producerId: "backend-main",
      destinations: ["posthog"],
    });
  const secondFingerprint =
    await fingerprintSemanticRequest({
      producerId: "backend-main",
      destinations: ["statsig"],
    });

  await beginIdempotentOperation(
    archive,
    env,
    {
      projectId: "customer-a",
      operation: "onboarding-v1",
      idempotencyKey: "same-key",
      requestFingerprint: firstFingerprint,
      recoveryPayload: { credential: "secret" },
      now: new Date("2026-09-24T00:00:00.000Z"),
    },
  );

  await assert.rejects(
    beginIdempotentOperation(
      archive,
      env,
      {
        projectId: "customer-a",
        operation: "onboarding-v1",
        idempotencyKey: "same-key",
        requestFingerprint: secondFingerprint,
        recoveryPayload: { credential: "other" },
        now: new Date("2026-09-24T00:00:01.000Z"),
      },
    ),
    IdempotencyKeyReusedError,
  );
});

test("same key is expired rather than executed as new", async () => {
  const archive = fakeArchive();
  const requestFingerprint =
    await fingerprintSemanticRequest({
      producerId: "backend-main",
      destinations: ["posthog"],
    });

  await beginIdempotentOperation(
    archive,
    env,
    {
      projectId: "customer-a",
      operation: "onboarding-v1",
      idempotencyKey: "expiring-key",
      requestFingerprint,
      recoveryPayload: { credential: "secret" },
      now: new Date("2026-09-24T00:00:00.000Z"),
      replaySeconds: 1,
    },
  );

  await assert.rejects(
    beginIdempotentOperation(
      archive,
      env,
      {
        projectId: "customer-a",
        operation: "onboarding-v1",
        idempotencyKey: "expiring-key",
        requestFingerprint,
        recoveryPayload: { credential: "other" },
        now: new Date("2026-09-24T00:00:02.000Z"),
        replaySeconds: 1,
      },
    ),
    IdempotencyKeyExpiredError,
  );
});

test("idempotency storage key contains only project operation and key fingerprint", async () => {
  const archive = fakeArchive();
  const requestFingerprint =
    await fingerprintSemanticRequest({
      producerId: "backend-main",
      destinations: ["posthog"],
    });

  const operation = await beginIdempotentOperation(
    archive,
    env,
    {
      projectId: "customer-a",
      operation: "onboarding-v1",
      idempotencyKey: "opaque-client-key",
      requestFingerprint,
      recoveryPayload: { credential: "secret" },
    },
  );

  assert.match(
    operation.key,
    /^registry\/idempotency\/customer-a\/onboarding-v1\/[0-9a-f]{64}\.json$/,
  );
  assert.equal(
    operation.key.includes("opaque-client-key"),
    false,
  );

  const record = JSON.parse(
    archive.objects.get(operation.key).body,
  );
  assert.equal(
    operation.key,
    idempotencyRecordKey(
      "customer-a",
      "onboarding-v1",
      record.keyFingerprint,
    ),
  );
});


test("new idempotency operations use v2 while unexpired v1 replay remains readable", async () => {
  const archive = fakeArchive();
  const versionedEnv = {
    ...env,
    ETLAYER_IDEMPOTENCY_SECRET_KEY_V2:
      "33".repeat(32),
  };
  const requestFingerprint =
    await fingerprintSemanticRequest({
      producerId: "backend-main",
      destinations: ["posthog"],
    });

  const first = await beginIdempotentOperation(
    archive,
    versionedEnv,
    {
      projectId: "customer-v",
      operation: "onboarding-v1",
      idempotencyKey: "v1-key",
      requestFingerprint,
      recoveryPayload: {
        credential: "etl_prod_v1",
      },
      now: new Date("2026-09-24T02:00:00.000Z"),
    },
  );

  assert.equal(first.record.keyVersion, "v1");

  await completeIdempotentOperation(
    archive,
    versionedEnv,
    {
      key: first.key,
      record: {
        ...first.record,
        statusCode: 201,
      },
      responsePayload: {
        credential: "etl_prod_v1",
      },
      now: new Date("2026-09-24T02:00:01.000Z"),
    },
  );

  const v2Env = {
    ...versionedEnv,
    ETLAYER_IDEMPOTENCY_SECRET_ACTIVE_VERSION: "v2",
  };

  const second = await beginIdempotentOperation(
    archive,
    v2Env,
    {
      projectId: "customer-v",
      operation: "onboarding-v1",
      idempotencyKey: "v2-key",
      requestFingerprint,
      recoveryPayload: {
        credential: "etl_prod_v2",
      },
      now: new Date("2026-09-24T02:00:02.000Z"),
    },
  );

  assert.equal(second.record.keyVersion, "v2");

  const replay = await beginIdempotentOperation(
    archive,
    v2Env,
    {
      projectId: "customer-v",
      operation: "onboarding-v1",
      idempotencyKey: "v1-key",
      requestFingerprint,
      recoveryPayload: {
        credential: "unused",
      },
      now: new Date("2026-09-24T02:00:03.000Z"),
    },
  );

  assert.equal(replay.replayed, true);
  assert.equal(replay.record.keyVersion, "v1");
  assert.deepEqual(replay.payload, {
    credential: "etl_prod_v1",
  });
});

test("idempotency completion stays on the operation key version even after active version changes", async () => {
  const archive = fakeArchive();
  const versionedEnv = {
    ...env,
    ETLAYER_IDEMPOTENCY_SECRET_KEY_V2:
      "33".repeat(32),
  };
  const requestFingerprint =
    await fingerprintSemanticRequest({
      producerId: "backend-main",
      destinations: ["posthog"],
    });

  const started = await beginIdempotentOperation(
    archive,
    versionedEnv,
    {
      projectId: "customer-pinned",
      operation: "onboarding-v1",
      idempotencyKey: "pinned-key",
      requestFingerprint,
      recoveryPayload: {
        credential: "etl_prod_pinned",
      },
      now: new Date("2026-09-24T02:10:00.000Z"),
    },
  );

  assert.equal(started.record.keyVersion, "v1");

  const completed = await completeIdempotentOperation(
    archive,
    {
      ...versionedEnv,
      ETLAYER_IDEMPOTENCY_SECRET_ACTIVE_VERSION: "v2",
    },
    {
      key: started.key,
      record: {
        ...started.record,
        statusCode: 201,
      },
      responsePayload: {
        credential: "etl_prod_pinned",
      },
      now: new Date("2026-09-24T02:10:01.000Z"),
    },
  );

  assert.equal(completed.keyVersion, "v1");

  const stored = JSON.parse(
    archive.objects.get(started.key).body,
  );
  assert.equal(stored.keyVersion, "v1");
});


test("expired v1 idempotency capsule does not require v1 root after drain", async () => {
  const archive = fakeArchive();
  const bothRoots = {
    ...env,
    ETLAYER_IDEMPOTENCY_SECRET_KEY_V2:
      "33".repeat(32),
  };
  const requestFingerprint =
    await fingerprintSemanticRequest({
      producerId: "backend-main",
      destinations: ["posthog"],
    });

  await beginIdempotentOperation(
    archive,
    bothRoots,
    {
      projectId: "customer-drain",
      operation: "onboarding-v1",
      idempotencyKey: "drained-v1-key",
      requestFingerprint,
      recoveryPayload: {
        credential: "etl_prod_old",
      },
      now: new Date("2026-09-24T04:00:00.000Z"),
      replaySeconds: 1,
    },
  );

  await assert.rejects(
    beginIdempotentOperation(
      archive,
      {
        ETLAYER_IDEMPOTENCY_SECRET_KEY_V2:
          "33".repeat(32),
        ETLAYER_IDEMPOTENCY_SECRET_ACTIVE_VERSION:
          "v2",
      },
      {
        projectId: "customer-drain",
        operation: "onboarding-v1",
        idempotencyKey: "drained-v1-key",
        requestFingerprint,
        recoveryPayload: {
          credential: "unused",
        },
        now: new Date("2026-09-24T04:00:02.000Z"),
        replaySeconds: 1,
      },
    ),
    IdempotencyKeyExpiredError,
  );

  const fresh = await beginIdempotentOperation(
    archive,
    {
      ETLAYER_IDEMPOTENCY_SECRET_KEY_V2:
        "33".repeat(32),
      ETLAYER_IDEMPOTENCY_SECRET_ACTIVE_VERSION:
        "v2",
    },
    {
      projectId: "customer-drain",
      operation: "onboarding-v1",
      idempotencyKey: "fresh-v2-key",
      requestFingerprint,
      recoveryPayload: {
        credential: "etl_prod_new",
      },
      now: new Date("2026-09-24T04:00:02.000Z"),
    },
  );

  assert.equal(fresh.record.keyVersion, "v2");
});

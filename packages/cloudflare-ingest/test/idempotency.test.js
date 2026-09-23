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

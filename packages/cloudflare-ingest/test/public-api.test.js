import assert from "node:assert/strict";
import test from "node:test";

import { handlePublicApiRequest } from "../src/public-api.js";
import {
  createRegistryProject,
  credentialFingerprint,
  setRegistryDestination,
} from "../src/registry.js";
import { validationStateKey } from "../src/validation-state.js";
import {
  deliveryStateKey,
} from "../src/delivery-state.js";
import {
  deliveryAttemptKey,
  deliveryResourceId,
} from "../src/delivery-attempt.js";

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
    async list({ prefix }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}

async function createProject(
  archive,
  projectId,
  operatorCredential,
) {
  const operatorFingerprint =
    await credentialFingerprint(operatorCredential);

  await createRegistryProject(archive, {
    projectId,
    operatorFingerprint,
    now: new Date("2026-09-24T01:00:00.000Z"),
  });
}

function onboardingRequest(
  projectId,
  operatorCredential,
  {
    idempotencyKey = "onboarding-request-1",
    body = {
      producerId: "backend-main",
      destinations: ["posthog"],
    },
  } = {},
) {
  const headers = {
    authorization: "Bearer " + operatorCredential,
    "content-type": "application/json",
  };

  if (idempotencyKey != null) {
    headers["idempotency-key"] = idempotencyKey;
  }

  return new Request(
    `https://events.test/api/v1/projects/${projectId}/onboarding`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
}

function eventStatusRequest(
  projectId,
  eventId,
  operatorCredential,
) {
  return new Request(
    `https://events.test/api/v1/projects/${projectId}/events/${eventId}`,
    {
      method: "GET",
      headers: {
        authorization: "Bearer " + operatorCredential,
      },
    },
  );
}

const idempotencySecret = "33".repeat(32);

test("public onboarding is retry-safe and exposes no internal product surfaces", async () => {
  const archive = fakeArchive();
  const operatorCredential = "etl_op_customer-a";
  await createProject(
    archive,
    "customer-a",
    operatorCredential,
  );

  const env = {
    ARCHIVE: archive,
    ETLAYER_IDEMPOTENCY_SECRET_KEY_V1:
      idempotencySecret,
  };
  const options = {
    now: new Date("2026-09-24T01:01:00.000Z"),
  };

  const first = await handlePublicApiRequest(
    onboardingRequest(
      "customer-a",
      operatorCredential,
    ),
    env,
    undefined,
    options,
  );

  assert.equal(first.status, 201);
  assert.equal(
    first.headers.get("idempotency-replayed"),
    "false",
  );

  const firstBody = await first.json();
  assert.equal(firstBody.apiVersion, "v1");
  assert.equal(firstBody.projectId, "customer-a");
  assert.match(firstBody.credential, /^etl_prod_/);
  assert.equal(
    firstBody.connection.endpoint,
    "https://events.test/v1/logs",
  );
  assert.equal(
    firstBody.eventStatus.urlTemplate,
    "https://events.test/api/v1/projects/customer-a/events/{eventId}",
  );
  assert.equal(
    firstBody.quickstart.source.includes("/_mgmt/"),
    false,
  );
  assert.equal(
    firstBody.quickstart.source.includes("/_ops/"),
    false,
  );
  assert.equal(
    firstBody.quickstart.source.includes(
      "etlayer.project.id",
    ),
    false,
  );

  const second = await handlePublicApiRequest(
    onboardingRequest(
      "customer-a",
      operatorCredential,
    ),
    env,
    undefined,
    {
      now: new Date("2026-09-24T01:01:10.000Z"),
    },
  );

  assert.equal(second.status, 201);
  assert.equal(
    second.headers.get("idempotency-replayed"),
    "true",
  );

  const secondBody = await second.json();
  assert.deepEqual(secondBody, firstBody);

  const persisted = [...archive.objects.values()]
    .map(({ body }) => body)
    .join("\n");

  assert.equal(
    persisted.includes(firstBody.credential),
    false,
  );
  assert.equal(
    persisted.includes("onboarding-request-1"),
    false,
  );

  const producerKeys = [...archive.objects.keys()].filter(
    (key) =>
      key ===
      "registry/producers/customer-a/backend-main.json",
  );
  assert.equal(producerKeys.length, 1);
});

test("same idempotency key with a different request returns stable conflict code", async () => {
  const archive = fakeArchive();
  const operatorCredential = "etl_op_customer-b";
  await createProject(
    archive,
    "customer-b",
    operatorCredential,
  );

  const env = {
    ARCHIVE: archive,
    ETLAYER_IDEMPOTENCY_SECRET_KEY_V1:
      idempotencySecret,
  };

  const first = await handlePublicApiRequest(
    onboardingRequest(
      "customer-b",
      operatorCredential,
      {
        idempotencyKey: "same-key",
        body: {
          producerId: "backend-main",
          destinations: ["posthog"],
        },
      },
    ),
    env,
  );
  assert.equal(first.status, 201);

  const conflict = await handlePublicApiRequest(
    onboardingRequest(
      "customer-b",
      operatorCredential,
      {
        idempotencyKey: "same-key",
        body: {
          producerId: "backend-main",
          destinations: ["statsig"],
        },
      },
    ),
    env,
  );

  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: {
      code: "idempotency_key_reused",
      message:
        "Idempotency key was already used with a different request",
    },
  });
});

test("public onboarding requires idempotency key and uses stable auth errors", async () => {
  const archive = fakeArchive();
  const operatorCredential = "etl_op_customer-c";
  await createProject(
    archive,
    "customer-c",
    operatorCredential,
  );

  const env = {
    ARCHIVE: archive,
    ETLAYER_IDEMPOTENCY_SECRET_KEY_V1:
      idempotencySecret,
  };

  const missing = await handlePublicApiRequest(
    onboardingRequest(
      "customer-c",
      operatorCredential,
      { idempotencyKey: null },
    ),
    env,
  );

  assert.equal(missing.status, 400);
  assert.equal(
    (await missing.json()).error.code,
    "idempotency_key_required",
  );

  const unauthorized = await handlePublicApiRequest(
    onboardingRequest(
      "customer-c",
      "wrong-operator",
    ),
    env,
  );

  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), {
    error: {
      code: "invalid_operator_credential",
      message:
        "Invalid operator credential for project",
    },
  });
});

test("public event status is project-scoped and strips internal source keys", async () => {
  const archive = fakeArchive();
  await createProject(
    archive,
    "project-a",
    "etl_op_project-a",
  );
  await createProject(
    archive,
    "project-b",
    "etl_op_project-b",
  );

  await setRegistryDestination(archive, {
    projectId: "project-a",
    destination: "posthog",
    enabled: true,
    now: new Date(
      "2026-09-24T01:09:00.000Z",
    ),
  });

  await archive.put(
    validationStateKey("evt-public-1", "project-a"),
    JSON.stringify({
      version: 2,
      projectId: "project-a",
      eventId: "evt-public-1",
      eventName: "account.created",
      status: "valid",
      errors: [],
      sourceKey:
        "projects/project-a/events/secret-internal-path.json",
      updatedAt: "2026-09-24T01:10:00.000Z",
    }),
  );

  const deliveryId = deliveryResourceId(
    "evt-public-1",
    "posthog",
    "project-a",
  );

  await archive.put(
    deliveryAttemptKey(
      "posthog",
      "evt-public-1",
      1,
      "attempt-public-1",
      "project-a",
    ),
    JSON.stringify({
      version: 1,
      projectId: "project-a",
      deliveryId,
      attemptId: "attempt-public-1",
      attemptNumber: 1,
      eventId: "evt-public-1",
      eventName: "account.created",
      destination: "posthog",
      mode: "live",
      status: "failed",
      error: {
        name: "Error",
        message: "private provider failure",
      },
      startedAt:
        "2026-09-24T01:10:01.000Z",
      completedAt:
        "2026-09-24T01:10:01.100Z",
    }),
  );

  await archive.put(
    deliveryStateKey(
      "posthog",
      "evt-public-1",
      "project-a",
    ),
    JSON.stringify({
      version: 3,
      projectId: "project-a",
      deliveryId,
      eventId: "evt-public-1",
      eventName: "account.created",
      destination: "posthog",
      status: "failed",
      attemptCount: 1,
      latestAttemptId: "attempt-public-1",
      latestAttemptNumber: 1,
      lastAttemptAt:
        "2026-09-24T01:10:01.100Z",
      updatedAt:
        "2026-09-24T01:10:01.100Z",
    }),
  );

  const env = {
    ARCHIVE: archive,
    ETLAYER_IDEMPOTENCY_SECRET_KEY_V1:
      idempotencySecret,
  };

  const response = await handlePublicApiRequest(
    eventStatusRequest(
      "project-a",
      "evt-public-1",
      "etl_op_project-a",
    ),
    env,
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.apiVersion, "v1");
  assert.equal(body.status, "processing");
  assert.equal(body.validation.status, "valid");
  assert.equal("sourceKey" in body.validation, false);
  assert.equal(
    JSON.stringify(body).includes(
      "secret-internal-path",
    ),
    false,
  );
  assert.equal(body.deliveries.length, 1);
  assert.equal(
    body.deliveries[0].status,
    "failed",
  );
  assert.equal(
    "attempts" in body.deliveries[0],
    false,
  );
  assert.equal(
    JSON.stringify(body).includes(
      "private provider failure",
    ),
    false,
  );

  const crossProject = await handlePublicApiRequest(
    eventStatusRequest(
      "project-a",
      "evt-public-1",
      "etl_op_project-b",
    ),
    env,
  );

  assert.equal(crossProject.status, 401);
  assert.equal(
    (await crossProject.json()).error.code,
    "invalid_operator_credential",
  );
});

test("unknown public event stays pending_or_unknown without exposing storage coordinates", async () => {
  const archive = fakeArchive();
  await createProject(
    archive,
    "project-c",
    "etl_op_project-c",
  );

  const response = await handlePublicApiRequest(
    eventStatusRequest(
      "project-c",
      "evt-not-visible",
      "etl_op_project-c",
    ),
    {
      ARCHIVE: archive,
      ETLAYER_IDEMPOTENCY_SECRET_KEY_V1:
        idempotencySecret,
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "pending_or_unknown");
  assert.equal(body.known, false);
  assert.equal(
    JSON.stringify(body).includes("sourceKey"),
    false,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { handleManagementRequest } from "../src/management-http.js";
import { authenticateIngest } from "../src/provenance.js";
import { routeEventDestinations } from "../src/destinations.js";
import {
  credentialFingerprint,
  operatorCredentialKey,
  producerCredentialKey,
} from "../src/registry.js";

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
        customMetadata: options.customMetadata || {},
        httpMetadata: options.httpMetadata || {},
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
    async list({ prefix = "" } = {}) {
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

function jsonRequest(
  method,
  path,
  token,
  body,
) {
  return new Request(
    `https://events.test${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

async function manage(
  env,
  method,
  path,
  token,
  body,
) {
  const request = jsonRequest(
    method,
    path,
    token,
    body,
  );

  return handleManagementRequest(
    request,
    env,
    new URL(request.url),
  );
}

function ingestRequest(token) {
  return new Request(
    "https://events.test/v1/logs",
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
}

test("dynamic project lifecycle creates one-time credentials and enforces rotate/disable", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
  };

  const projectResponse = await manage(
    env,
    "POST",
    "/_mgmt/projects",
    "management-key",
    { id: "customer-a" },
  );

  assert.equal(projectResponse.status, 201);
  const projectBody = await projectResponse.json();
  const operatorCredential =
    projectBody.operatorCredential;

  assert.match(operatorCredential, /^etl_op_/);
  assert.deepEqual(projectBody.project.destinations, []);

  const producerResponse = await manage(
    env,
    "POST",
    "/_mgmt/projects/customer-a/producers",
    operatorCredential,
    {
      id: "backend-main",
      profileId: "backend",
    },
  );

  assert.equal(producerResponse.status, 201);
  const producerBody = await producerResponse.json();
  const originalCredential = producerBody.credential;

  assert.match(originalCredential, /^etl_prod_/);
  assert.equal(
    producerBody.producer.projectId,
    "customer-a",
  );
  assert.equal(
    producerBody.producer.profileId,
    "backend",
  );

  const destinationResponse = await manage(
    env,
    "PUT",
    "/_mgmt/projects/customer-a/destinations/posthog",
    operatorCredential,
    { enabled: true },
  );

  assert.equal(destinationResponse.status, 200);
  assert.deepEqual(
    (await destinationResponse.json()).project.destinations,
    ["posthog"],
  );

  const authenticated = await authenticateIngest(
    ingestRequest(originalCredential),
    env,
  );

  assert.equal(authenticated.ok, true);
  assert.equal(
    authenticated.provenance.projectId,
    "customer-a",
  );
  assert.equal(
    authenticated.provenance.producer.kind,
    "backend",
  );

  const routed = await routeEventDestinations(
    {
      id: "evt_dynamic",
      eventName: "account.created",
      provenance: authenticated.provenance,
    },
    env,
    {
      async readState() {
        return null;
      },
      async recordState() {},
    },
  );

  assert.deepEqual(
    routed.map(({ destination }) => destination),
    ["posthog"],
  );

  const rotateResponse = await manage(
    env,
    "POST",
    "/_mgmt/projects/customer-a/producers/backend-main/rotate",
    operatorCredential,
    {},
  );

  assert.equal(rotateResponse.status, 200);
  const rotatedBody = await rotateResponse.json();
  const rotatedCredential = rotatedBody.credential;

  assert.match(rotatedCredential, /^etl_prod_/);
  assert.notEqual(
    rotatedCredential,
    originalCredential,
  );

  const oldAuthentication = await authenticateIngest(
    ingestRequest(originalCredential),
    env,
  );
  assert.deepEqual(oldAuthentication, {
    ok: false,
    reason: "invalid_ingest_credential",
  });

  const newAuthentication = await authenticateIngest(
    ingestRequest(rotatedCredential),
    env,
  );
  assert.equal(newAuthentication.ok, true);

  const disableResponse = await manage(
    env,
    "POST",
    "/_mgmt/projects/customer-a/producers/backend-main/disable",
    operatorCredential,
    {},
  );

  assert.equal(disableResponse.status, 200);
  assert.equal(
    (await disableResponse.json()).producer.status,
    "disabled",
  );

  const disabledAuthentication =
    await authenticateIngest(
      ingestRequest(rotatedCredential),
      env,
    );

  assert.deepEqual(disabledAuthentication, {
    ok: false,
    reason: "invalid_ingest_credential",
  });

  const persisted = [...archive.objects.values()]
    .map(({ body }) => body)
    .join("\n");

  assert.equal(
    persisted.includes(operatorCredential),
    false,
  );
  assert.equal(
    persisted.includes(originalCredential),
    false,
  );
  assert.equal(
    persisted.includes(rotatedCredential),
    false,
  );

  const operatorFingerprint =
    await credentialFingerprint(operatorCredential);
  const rotatedFingerprint =
    await credentialFingerprint(rotatedCredential);

  const operatorEvidence = await manage(
    env,
    "POST",
    "/_mgmt/evidence",
    "management-key",
    {
      key: operatorCredentialKey(operatorFingerprint),
    },
  );
  assert.equal(operatorEvidence.status, 200);
  const operatorRecord = await operatorEvidence.json();
  assert.equal(operatorRecord.projectId, "customer-a");
  assert.equal(operatorRecord.fingerprint, operatorFingerprint);
  assert.equal(
    JSON.stringify(operatorRecord).includes(
      operatorCredential,
    ),
    false,
  );

  const producerEvidence = await manage(
    env,
    "POST",
    "/_mgmt/evidence",
    "management-key",
    {
      key: producerCredentialKey(rotatedFingerprint),
    },
  );
  assert.equal(producerEvidence.status, 200);
  const producerRecord = await producerEvidence.json();
  assert.equal(producerRecord.projectId, "customer-a");
  assert.equal(
    producerRecord.fingerprint,
    rotatedFingerprint,
  );
  assert.equal(
    JSON.stringify(producerRecord).includes(
      rotatedCredential,
    ),
    false,
  );
});

test("operator from another dynamic project cannot mutate the project", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
  };

  const projectA = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "project-a" },
    )
  ).json();

  const projectB = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "project-b" },
    )
  ).json();

  const response = await manage(
    env,
    "POST",
    "/_mgmt/projects/project-a/producers",
    projectB.operatorCredential,
    {
      id: "backend-main",
      profileId: "backend",
    },
  );

  assert.equal(response.status, 401);

  const allowed = await manage(
    env,
    "POST",
    "/_mgmt/projects/project-a/producers",
    projectA.operatorCredential,
    {
      id: "backend-main",
      profileId: "backend",
    },
  );

  assert.equal(allowed.status, 201);
});

test("management rejects static project collisions and unsupported destinations", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
  };

  const staticCollision = await manage(
    env,
    "POST",
    "/_mgmt/projects",
    "management-key",
    { id: "etlayer-default" },
  );

  assert.equal(staticCollision.status, 409);

  const created = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "project-c" },
    )
  ).json();

  const unsupported = await manage(
    env,
    "PUT",
    "/_mgmt/projects/project-c/destinations/splunk",
    created.operatorCredential,
    { enabled: true },
  );

  assert.equal(unsupported.status, 400);
});


test("global management can rewrap a destination root while project operator cannot", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
    ETLAYER_DESTINATION_SECRET_KEY_V1:
      "11".repeat(32),
    ETLAYER_DESTINATION_SECRET_KEY_V2:
      "22".repeat(32),
  };

  const project = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "rotation-a" },
    )
  ).json();

  const configured = await manage(
    env,
    "PUT",
    "/_mgmt/projects/rotation-a/destinations/posthog/credential",
    project.operatorCredential,
    { secret: "provider-secret" },
  );

  assert.equal(configured.status, 200);
  assert.equal(
    (await configured.json()).credential.keyVersion,
    "v1",
  );

  const denied = await manage(
    env,
    "POST",
    "/_mgmt/projects/rotation-a/destinations/posthog/credential/rewrap",
    project.operatorCredential,
    { targetKeyVersion: "v2" },
  );
  assert.equal(denied.status, 401);

  const rewrapped = await manage(
    env,
    "POST",
    "/_mgmt/projects/rotation-a/destinations/posthog/credential/rewrap",
    "management-key",
    { targetKeyVersion: "v2" },
  );

  assert.equal(rewrapped.status, 200);
  const body = await rewrapped.json();
  assert.equal(body.rewrapped, true);
  assert.equal(body.previous.keyVersion, "v1");
  assert.equal(body.credential.keyVersion, "v2");

  const persisted = [...archive.objects.values()]
    .map(({ body: storedBody }) => storedBody)
    .join("\n");

  assert.equal(
    persisted.includes("provider-secret"),
    false,
  );
});

test("global key usage audit reports destination migration and idempotency drain readiness", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
    ETLAYER_DESTINATION_SECRET_KEY_V1:
      "11".repeat(32),
    ETLAYER_DESTINATION_SECRET_KEY_V2:
      "22".repeat(32),
  };

  const project = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "rotation-usage" },
    )
  ).json();

  await manage(
    env,
    "PUT",
    "/_mgmt/projects/rotation-usage/destinations/posthog/credential",
    project.operatorCredential,
    { secret: "provider-secret" },
  );

  await archive.put(
    "registry/idempotency/rotation-usage/onboarding-v1/example.json",
    JSON.stringify({
      version: 1,
      kind: "public_idempotency",
      projectId: "rotation-usage",
      operation: "onboarding-v1",
      keyVersion: "v1",
      status: "completed",
      replayUntil: "2026-09-24T10:00:00.000Z",
    }),
  );

  const usageRequest = new Request(
    "https://events.test/_mgmt/encryption/key-usage",
    {
      method: "GET",
      headers: {
        authorization: "Bearer management-key",
      },
    },
  );

  const before = await handleManagementRequest(
    usageRequest,
    env,
    new URL(usageRequest.url),
    {
      now: new Date("2026-09-24T09:00:00.000Z"),
    },
  );

  assert.equal(before.status, 200);
  const beforeBody = await before.json();
  assert.equal(
    beforeBody.usage.destination.versions.v1
      .retirementSafe,
    false,
  );
  assert.equal(
    beforeBody.usage.idempotency.versions.v1
      .retirementSafe,
    false,
  );

  await manage(
    env,
    "POST",
    "/_mgmt/projects/rotation-usage/destinations/posthog/credential/rewrap",
    "management-key",
    { targetKeyVersion: "v2" },
  );

  const afterRequest = new Request(
    "https://events.test/_mgmt/encryption/key-usage",
    {
      method: "GET",
      headers: {
        authorization: "Bearer management-key",
      },
    },
  );

  const after = await handleManagementRequest(
    afterRequest,
    env,
    new URL(afterRequest.url),
    {
      now: new Date("2026-09-24T11:00:00.000Z"),
    },
  );

  assert.equal(after.status, 200);
  const afterBody = await after.json();

  assert.deepEqual(
    afterBody.usage.destination.versions.v1,
    {
      activePointers: 0,
      retirementSafe: true,
    },
  );
  assert.deepEqual(
    afterBody.usage.destination.versions.v2,
    {
      activePointers: 1,
      retirementSafe: false,
    },
  );
  assert.deepEqual(
    afterBody.usage.idempotency.versions.v1,
    {
      unexpiredCapsules: 0,
      retirementSafe: true,
    },
  );
});


test("global encryption config exposes active versions without secret material", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
    ETLAYER_DESTINATION_SECRET_ACTIVE_VERSION: "v2",
    ETLAYER_IDEMPOTENCY_SECRET_ACTIVE_VERSION: "v1",
    ETLAYER_DESTINATION_SECRET_KEY_V1:
      "11".repeat(32),
    ETLAYER_DESTINATION_SECRET_KEY_V2:
      "22".repeat(32),
    ETLAYER_IDEMPOTENCY_SECRET_KEY_V1:
      "33".repeat(32),
  };

  const request = new Request(
    "https://events.test/_mgmt/encryption/config",
    {
      method: "GET",
      headers: {
        authorization: "Bearer management-key",
      },
    },
  );

  const response = await handleManagementRequest(
    request,
    env,
    new URL(request.url),
  );

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body, {
    destination: {
      activeKeyVersion: "v2",
    },
    idempotency: {
      activeKeyVersion: "v1",
    },
  });

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("11".repeat(32)), false);
  assert.equal(serialized.includes("22".repeat(32)), false);
  assert.equal(serialized.includes("33".repeat(32)), false);
});

test("project operator cannot read global encryption config", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
  };

  const request = new Request(
    "https://events.test/_mgmt/encryption/config",
    {
      method: "GET",
      headers: {
        authorization: "Bearer etl_op_project-a",
      },
    },
  );

  const response = await handleManagementRequest(
    request,
    env,
    new URL(request.url),
  );

  assert.equal(response.status, 401);
});

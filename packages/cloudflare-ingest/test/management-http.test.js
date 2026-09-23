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

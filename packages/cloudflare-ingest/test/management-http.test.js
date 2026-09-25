import assert from "node:assert/strict";
import test from "node:test";

import { handleManagementRequest } from "../src/management-http.js";
import { controlPlaneAuditKey } from "../src/control-plane-audit.js";
import { authenticateIngest } from "../src/provenance.js";
import { routeEventDestinations } from "../src/destinations.js";
import {
  credentialFingerprint,
  operatorCredentialKey,
  producerCredentialKey,
} from "../src/registry.js";
import {
  governanceContractKey,
  governancePublicationKey,
} from "../src/governance-publication.js";
import {
  governanceManifestDigest,
} from "../src/governance-manifest.js";

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


test("control-plane mutations emit append-only attributable audit evidence", async () => {
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
    { id: "audit-a" },
  );

  assert.equal(projectResponse.status, 201);
  const projectOperation =
    projectResponse.headers.get(
      "x-etlayer-operation-id",
    );
  assert.ok(projectOperation);

  const projectBody = await projectResponse.json();
  const operatorCredential =
    projectBody.operatorCredential;

  const producerResponse = await manage(
    env,
    "POST",
    "/_mgmt/projects/audit-a/producers",
    operatorCredential,
    {
      id: "backend-main",
      profileId: "backend",
    },
  );
  assert.equal(producerResponse.status, 201);
  const producerOperation =
    producerResponse.headers.get(
      "x-etlayer-operation-id",
    );
  assert.ok(producerOperation);
  const producerBody = await producerResponse.json();
  const producerCredential =
    producerBody.credential;

  const destinationResponse = await manage(
    env,
    "PUT",
    "/_mgmt/projects/audit-a/destinations/posthog",
    operatorCredential,
    { enabled: true },
  );
  assert.equal(destinationResponse.status, 200);
  const destinationOperation =
    destinationResponse.headers.get(
      "x-etlayer-operation-id",
    );
  assert.ok(destinationOperation);

  const rotateResponse = await manage(
    env,
    "POST",
    "/_mgmt/projects/audit-a/producers/backend-main/rotate",
    operatorCredential,
    {},
  );
  assert.equal(rotateResponse.status, 200);
  const rotateOperation =
    rotateResponse.headers.get(
      "x-etlayer-operation-id",
    );
  assert.ok(rotateOperation);
  const rotatedCredential =
    (await rotateResponse.json()).credential;

  const disableResponse = await manage(
    env,
    "POST",
    "/_mgmt/projects/audit-a/producers/backend-main/disable",
    operatorCredential,
    {},
  );
  assert.equal(disableResponse.status, 200);
  const disableOperation =
    disableResponse.headers.get(
      "x-etlayer-operation-id",
    );
  assert.ok(disableOperation);

  const expectations = [
    {
      operationId: projectOperation,
      action: "project.create",
      actor: "management",
      target: "project",
    },
    {
      operationId: producerOperation,
      action: "producer.create",
      actor: "project_operator",
      target: "producer",
    },
    {
      operationId: destinationOperation,
      action: "destination.configure",
      actor: "project_operator",
      target: "destination",
    },
    {
      operationId: rotateOperation,
      action: "producer.rotate",
      actor: "project_operator",
      target: "producer",
    },
    {
      operationId: disableOperation,
      action: "producer.disable",
      actor: "project_operator",
      target: "producer",
    },
  ];

  for (const expectation of expectations) {
    const requestedResponse = await manage(
      env,
      "POST",
      "/_mgmt/evidence",
      "management-key",
      {
        key: controlPlaneAuditKey(
          expectation.operationId,
          "requested",
        ),
      },
    );
    assert.equal(requestedResponse.status, 200);

    const appliedResponse = await manage(
      env,
      "POST",
      "/_mgmt/evidence",
      "management-key",
      {
        key: controlPlaneAuditKey(
          expectation.operationId,
          "applied",
        ),
      },
    );
    assert.equal(appliedResponse.status, 200);

    const requested = await requestedResponse.json();
    const applied = await appliedResponse.json();

    assert.equal(
      requested.operationId,
      expectation.operationId,
    );
    assert.equal(requested.phase, "requested");
    assert.equal(applied.phase, "applied");
    assert.equal(requested.action, expectation.action);
    assert.equal(requested.actor.kind, expectation.actor);
    assert.equal(requested.target.kind, expectation.target);
    assert.equal(requested.target.projectId, "audit-a");
    assert.equal(
      typeof requested.recordedAt,
      "string",
    );
  }

  const auditBeforeUnauthorized = [
    ...archive.objects.keys(),
  ].filter((key) =>
    key.startsWith("registry/audit/"),
  ).length;

  const projectB = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "audit-b" },
    )
  ).json();

  const auditAfterProjectB = [
    ...archive.objects.keys(),
  ].filter((key) =>
    key.startsWith("registry/audit/"),
  ).length;

  const denied = await manage(
    env,
    "PUT",
    "/_mgmt/projects/audit-a/destinations/statsig",
    projectB.operatorCredential,
    { enabled: true },
  );

  assert.equal(denied.status, 401);
  assert.equal(
    denied.headers.get("x-etlayer-operation-id"),
    null,
  );

  const auditAfterUnauthorized = [
    ...archive.objects.keys(),
  ].filter((key) =>
    key.startsWith("registry/audit/"),
  ).length;

  assert.equal(
    auditAfterUnauthorized,
    auditAfterProjectB,
  );
  assert.ok(
    auditAfterProjectB > auditBeforeUnauthorized,
  );

  const auditBodies = [
    ...archive.objects.entries(),
  ]
    .filter(([key]) =>
      key.startsWith("registry/audit/"),
    )
    .map(([, { body }]) => body)
    .join("\n");

  for (const secret of [
    "management-key",
    operatorCredential,
    producerCredential,
    rotatedCredential,
    projectB.operatorCredential,
  ]) {
    assert.equal(
      auditBodies.includes(secret),
      false,
    );
  }
});

test("project operator publishes exactly the planned governance manifest with audit evidence", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY:
      "management-key",
  };

  const created = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "governance-a" },
    )
  ).json();

  const manifest = {
    apiVersion: "etlayer.dev/v1",
    kind: "ProjectGovernance",
    projectId: "governance-a",
    contracts: [
      {
        eventName:
          "account.created",
        currentVersion: 1,
        compatibilityMode:
          "backward",
        proposedContract: {
          id: "account.created@2",
          eventName:
            "account.created",
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
              const:
                "business_state",
            },
          },
          forbidden: [
            "experiment.id",
            "experiment.variant",
          ],
        },
        from:
          "2026-09-25T10:00:00Z",
        to:
          "2026-09-25T11:00:00Z",
      },
    ],
  };

  const digest =
    await governanceManifestDigest(
      manifest,
    );

  const wrongDigest = await manage(
    env,
    "POST",
    "/_mgmt/projects/governance-a/governance/publish",
    created.operatorCredential,
    {
      manifest,
      manifestDigest:
        "0".repeat(64),
      acknowledgeBreaking: true,
    },
  );

  assert.equal(
    wrongDigest.status,
    409,
  );
  assert.equal(
    archive.objects.has(
      governancePublicationKey(
        "governance-a",
        digest,
      ),
    ),
    false,
  );

  const notAcknowledged =
    await manage(
      env,
      "POST",
      "/_mgmt/projects/governance-a/governance/publish",
      created.operatorCredential,
      {
        manifest,
        manifestDigest: digest,
      },
    );

  assert.equal(
    notAcknowledged.status,
    409,
  );

  const published = await manage(
    env,
    "POST",
    "/_mgmt/projects/governance-a/governance/publish",
    created.operatorCredential,
    {
      manifest,
      manifestDigest: digest,
      acknowledgeBreaking: true,
    },
  );

  assert.equal(published.status, 201);
  const operationId =
    published.headers.get(
      "x-etlayer-operation-id",
    );
  assert.ok(operationId);

  const body = await published.json();
  assert.equal(body.created, true);
  assert.equal(
    body.publication.manifestDigest,
    digest,
  );
  assert.equal(
    body.publication.compatible,
    false,
  );
  assert.equal(
    archive.objects.has(
      governanceContractKey(
        "governance-a",
        "account.created",
        2,
      ),
    ),
    true,
  );
  assert.equal(
    archive.objects.has(
      governancePublicationKey(
        "governance-a",
        digest,
      ),
    ),
    true,
  );

  const requested =
    await manage(
      env,
      "POST",
      "/_mgmt/evidence",
      "management-key",
      {
        key: controlPlaneAuditKey(
          operationId,
          "requested",
        ),
      },
    );

  assert.equal(requested.status, 200);
  const audit =
    await requested.json();
  assert.equal(
    audit.action,
    "governance.publish",
  );
  assert.equal(
    audit.actor.kind,
    "project_operator",
  );
  assert.equal(
    audit.target.projectId,
    "governance-a",
  );
  assert.equal(
    audit.target.manifestDigest,
    digest,
  );

  const repeated = await manage(
    env,
    "POST",
    "/_mgmt/projects/governance-a/governance/publish",
    created.operatorCredential,
    {
      manifest,
      manifestDigest: digest,
      acknowledgeBreaking: true,
    },
  );

  assert.equal(repeated.status, 200);
  assert.equal(
    (await repeated.json()).created,
    false,
  );
});


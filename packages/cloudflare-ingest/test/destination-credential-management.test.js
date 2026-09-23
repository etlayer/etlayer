import assert from "node:assert/strict";
import test from "node:test";

import { handleManagementRequest } from "../src/management-http.js";
import {
  destinationCredentialCurrentKey,
  destinationCredentialVersionKey,
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
        async text() {
          return stored.body;
        },
      };
    },
  };
}

function request(method, path, token, body) {
  const init = {
    method,
    headers: {
      authorization: "Bearer " + token,
    },
  };

  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  return new Request(
    "https://events.test" + path,
    init,
  );
}

async function manage(
  env,
  method,
  path,
  token,
  body,
) {
  const req = request(method, path, token, body);
  return handleManagementRequest(
    req,
    env,
    new URL(req.url),
  );
}

async function createProject(env, id) {
  const response = await manage(
    env,
    "POST",
    "/_mgmt/projects",
    env.ETLAYER_MANAGEMENT_KEY,
    { id },
  );

  assert.equal(response.status, 201);
  return response.json();
}

test("project operator can write rotate inspect and disable a destination credential without secret readback", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
    ETLAYER_DESTINATION_SECRET_KEY_V1:
      "33".repeat(32),
  };

  const project = await createProject(env, "project-a");
  const path =
    "/_mgmt/projects/project-a/destinations/posthog/credential";

  const first = await manage(
    env,
    "PUT",
    path,
    project.operatorCredential,
    { secret: "phc_first" },
  );

  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.credential.configured, true);
  assert.equal(firstBody.credential.status, "active");
  assert.equal(firstBody.credential.keyVersion, "v1");
  assert.equal(firstBody.credential.algorithm, "AES-256-GCM");
  assert.equal("secret" in firstBody.credential, false);
  assert.equal("ciphertext" in firstBody.credential, false);
  const firstId = firstBody.credential.credentialId;

  const status = await manage(
    env,
    "GET",
    path,
    project.operatorCredential,
  );

  assert.equal(status.status, 200);
  assert.deepEqual(
    await status.json(),
    firstBody,
  );

  const second = await manage(
    env,
    "PUT",
    path,
    project.operatorCredential,
    { secret: "phc_second" },
  );

  assert.equal(second.status, 200);
  const secondBody = await second.json();
  const secondId = secondBody.credential.credentialId;
  assert.notEqual(secondId, firstId);

  assert.equal(
    archive.objects.has(
      destinationCredentialVersionKey(
        "project-a",
        "posthog",
        firstId,
      ),
    ),
    true,
  );
  assert.equal(
    archive.objects.has(
      destinationCredentialVersionKey(
        "project-a",
        "posthog",
        secondId,
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
  assert.equal(pointer.credentialId, secondId);

  const persisted = [...archive.objects.values()]
    .map(({ body }) => body)
    .join("\n");

  assert.equal(
    persisted.includes("phc_first"),
    false,
  );
  assert.equal(
    persisted.includes("phc_second"),
    false,
  );

  const disabled = await manage(
    env,
    "POST",
    path + "/disable",
    project.operatorCredential,
    {},
  );

  assert.equal(disabled.status, 200);
  const disabledBody = await disabled.json();
  assert.equal(
    disabledBody.credential.status,
    "disabled",
  );
  assert.equal(
    disabledBody.credential.configured,
    false,
  );
});

test("global management can bootstrap an existing runtime destination secret without returning it", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
    ETLAYER_DESTINATION_SECRET_KEY_V1:
      "44".repeat(32),
    POSTHOG_PROJECT_TOKEN:
      "phc_runtime_default_secret",
  };

  const project = await createProject(env, "project-a");

  const response = await manage(
    env,
    "POST",
    "/_mgmt/projects/project-a/destinations/posthog/credential/bootstrap-runtime-default",
    "management-key",
    {},
  );

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.source, "runtime_default");
  assert.equal(body.credential.configured, true);
  assert.equal("secret" in body.credential, false);

  const serialized = JSON.stringify(body);
  assert.equal(
    serialized.includes(
      "phc_runtime_default_secret",
    ),
    false,
  );

  const operatorAttempt = await manage(
    env,
    "POST",
    "/_mgmt/projects/project-a/destinations/posthog/credential/bootstrap-runtime-default",
    project.operatorCredential,
    {},
  );

  assert.equal(operatorAttempt.status, 401);
});

test("destination credential APIs preserve project isolation", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
    ETLAYER_DESTINATION_SECRET_KEY_V1:
      "55".repeat(32),
  };

  const projectA = await createProject(env, "project-a");
  const projectB = await createProject(env, "project-b");

  const response = await manage(
    env,
    "PUT",
    "/_mgmt/projects/project-a/destinations/posthog/credential",
    projectB.operatorCredential,
    { secret: "phc_forbidden" },
  );

  assert.equal(response.status, 401);

  const allowed = await manage(
    env,
    "PUT",
    "/_mgmt/projects/project-a/destinations/posthog/credential",
    projectA.operatorCredential,
    { secret: "phc_allowed" },
  );

  assert.equal(allowed.status, 200);
});

test("static reference projects reject project-scoped destination credential writes", async () => {
  const response = await manage(
    {
      ARCHIVE: fakeArchive(),
      ETLAYER_REPLAY_KEY: "static-operator",
      ETLAYER_DESTINATION_SECRET_KEY_V1:
        "66".repeat(32),
    },
    "PUT",
    "/_mgmt/projects/etlayer-default/destinations/posthog/credential",
    "static-operator",
    { secret: "phc_nope" },
  );

  assert.equal(response.status, 400);
});

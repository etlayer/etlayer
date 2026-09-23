import assert from "node:assert/strict";
import test from "node:test";

import { handleManagementRequest } from "../src/management-http.js";

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

function request(method, path, token, body) {
  return new Request(
    "https://events.example.test" + path,
    {
      method,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

async function manage(env, method, path, token, body) {
  const req = request(method, path, token, body);
  return handleManagementRequest(
    req,
    env,
    new URL(req.url),
  );
}

test("provisions a backend onboarding bundle with copy-ready OTLP settings", async () => {
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
    { id: "external-a" },
  );

  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();

  const response = await manage(
    env,
    "POST",
    "/_mgmt/projects/external-a/onboarding",
    project.operatorCredential,
    {
      producerId: "backend-main",
      destinations: ["posthog"],
    },
  );

  assert.equal(response.status, 201);
  const bundle = await response.json();

  assert.equal(bundle.version, 1);
  assert.equal(bundle.projectId, "external-a");
  assert.equal(bundle.producer.profileId, "backend");
  assert.equal(bundle.producer.producerKind, "backend");
  assert.deepEqual(bundle.destinations, ["posthog"]);
  assert.match(bundle.credential, /^etl_prod_/);

  assert.deepEqual(bundle.connection, {
    protocol: "otlp/http-json",
    endpoint: "https://events.example.test/v1/logs",
    headers: {
      authorization: "Bearer " + bundle.credential,
      "content-type": "application/json",
    },
  });

  assert.equal(
    bundle.inspect.endpoint,
    "https://events.example.test/_ops/inspect",
  );
  assert.equal(bundle.inspect.body.projectId, "external-a");
  assert.equal(bundle.inspect.body.eventId, "<event-id>");

  const source = bundle.quickstart.source;
  assert.match(source, /account\.created/);
  assert.match(source, /etlayer\.schema\.version/);
  assert.match(source, /actor\.anonymous\.id/);
  assert.match(source, /account\.id/);
  assert.match(source, /etlayer\.producer\.kind/);
  assert.match(source, /business_state/);
  assert.match(source, /crypto\.randomUUID/);
  assert.match(
    source,
    /https:\/\/events\.example\.test\/v1\/logs/,
  );
  assert.match(
    source,
    /https:\/\/events\.example\.test\/_ops\/inspect/,
  );

  const persisted = [...archive.objects.values()]
    .map(({ body }) => body)
    .join("\n");

  assert.equal(
    persisted.includes(bundle.credential),
    false,
  );
});

test("onboarding validates destination names before creating a producer", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY: "management-key",
  };

  const project = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "external-b" },
    )
  ).json();

  const response = await manage(
    env,
    "POST",
    "/_mgmt/projects/external-b/onboarding",
    project.operatorCredential,
    {
      producerId: "backend-main",
      destinations: ["splunk"],
    },
  );

  assert.equal(response.status, 400);

  const producerKey =
    "registry/producers/external-b/backend-main.json";
  assert.equal(archive.objects.has(producerKey), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateIngest,
  stampTrustedProvenance,
} from "../src/provenance.js";
import {
  createRegistryProducer,
  credentialFingerprint,
} from "../src/registry.js";
import { profileTemplate } from "../src/project-config.js";

function request(token) {
  return new Request("https://events.test/v1/logs", {
    headers: token
      ? { authorization: `Bearer ${token}` }
      : {},
  });
}

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

test("authenticates browser backend and agent-runtime profiles", async () => {
  const env = {
    ETLAYER_BROWSER_INGEST_KEY: "browser-key",
    ETLAYER_BACKEND_INGEST_KEY: "backend-key",
    ETLAYER_AGENT_INGEST_KEY: "agent-key",
  };

  assert.deepEqual(
    await authenticateIngest(request("browser-key"), env),
    {
      ok: true,
      provenance: {
        version: 2,
        projectId: "etlayer-default",
        profileId: "browser",
        authentication: "bearer_profile",
        producer: { kind: "browser" },
        allowedAuthorityKinds: ["interaction"],
      },
    },
  );

  assert.equal(
    (
      await authenticateIngest(
        request("backend-key"),
        env,
      )
    ).provenance.producer.kind,
    "backend",
  );

  assert.deepEqual(
    (
      await authenticateIngest(
        request("agent-key"),
        env,
      )
    ).provenance.allowedAuthorityKinds,
    ["agent_runtime"],
  );
});

test("secondary project credential resolves a different trusted project", async () => {
  const result = await authenticateIngest(
    request("secondary-key"),
    {
      ETLAYER_SECONDARY_BACKEND_INGEST_KEY:
        "secondary-key",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(
    result.provenance.projectId,
    "etlayer-secondary",
  );
  assert.equal(result.provenance.profileId, "backend");
  assert.equal(
    result.provenance.producer.kind,
    "backend",
  );
});

test("legacy credential remains authenticated but grants no authority", async () => {
  const result = await authenticateIngest(
    request("legacy-key"),
    { ETLAYER_INGEST_KEY: "legacy-key" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.provenance.profileId, "legacy");
  assert.deepEqual(result.provenance.allowedAuthorityKinds, []);
});

test("does not authenticate unknown or missing credentials", async () => {
  assert.deepEqual(
    await authenticateIngest(request("wrong"), {
      ETLAYER_BACKEND_INGEST_KEY: "backend-key",
    }),
    {
      ok: false,
      reason: "invalid_ingest_credential",
    },
  );

  assert.deepEqual(
    await authenticateIngest(request("anything"), {}),
    {
      ok: false,
      reason: "ingest_credentials_not_configured",
    },
  );
});

test("authenticates an active dynamic producer from credential fingerprint", async () => {
  const archive = fakeArchive();
  const credential = "etl_prod_dynamic-secret";
  const fingerprint = await credentialFingerprint(
    credential,
  );

  await createRegistryProducer(archive, {
    projectId: "dynamic-project",
    producerId: "backend-main",
    profile: profileTemplate("backend"),
    credentialFingerprint: fingerprint,
    now: new Date("2026-09-23T03:00:00.000Z"),
  });

  const result = await authenticateIngest(
    request(credential),
    { ARCHIVE: archive },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.provenance, {
    version: 2,
    projectId: "dynamic-project",
    profileId: "backend",
    authentication: "bearer_profile",
    producer: { kind: "backend" },
    allowedAuthorityKinds: ["business_state"],
  });
});

test("stamps provenance without credential material", () => {
  const event = {
    id: "evt_1",
    eventName: "account.created",
  };

  const stamped = stampTrustedProvenance(event, {
    version: 2,
    projectId: "etlayer-default",
    profileId: "backend",
    authentication: "bearer_profile",
    producer: { kind: "backend" },
    allowedAuthorityKinds: ["business_state"],
  });

  assert.equal(
    stamped.provenance.projectId,
    "etlayer-default",
  );
  assert.equal(stamped.provenance.profileId, "backend");
  assert.equal(
    JSON.stringify(stamped).includes("backend-key"),
    false,
  );
});

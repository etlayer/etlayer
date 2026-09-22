import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateIngest,
  stampTrustedProvenance,
} from "../src/provenance.js";

function request(token) {
  return new Request("https://events.test/v1/logs", {
    headers: token
      ? { authorization: `Bearer ${token}` }
      : {},
  });
}

test("authenticates browser backend and agent-runtime profiles", () => {
  const env = {
    ETLAYER_BROWSER_INGEST_KEY: "browser-key",
    ETLAYER_BACKEND_INGEST_KEY: "backend-key",
    ETLAYER_AGENT_INGEST_KEY: "agent-key",
  };

  assert.deepEqual(
    authenticateIngest(request("browser-key"), env),
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
    authenticateIngest(request("backend-key"), env)
      .provenance.producer.kind,
    "backend",
  );

  assert.deepEqual(
    authenticateIngest(request("agent-key"), env)
      .provenance.allowedAuthorityKinds,
    ["agent_runtime"],
  );
});

test("secondary project credential resolves a different trusted project", () => {
  const result = authenticateIngest(
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

test("legacy credential remains authenticated but grants no authority", () => {
  const result = authenticateIngest(
    request("legacy-key"),
    { ETLAYER_INGEST_KEY: "legacy-key" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.provenance.profileId, "legacy");
  assert.deepEqual(result.provenance.allowedAuthorityKinds, []);
});

test("does not authenticate unknown or missing credentials", () => {
  assert.deepEqual(
    authenticateIngest(request("wrong"), {
      ETLAYER_BACKEND_INGEST_KEY: "backend-key",
    }),
    {
      ok: false,
      reason: "invalid_ingest_credential",
    },
  );

  assert.deepEqual(
    authenticateIngest(request("anything"), {}),
    {
      ok: false,
      reason: "ingest_credentials_not_configured",
    },
  );
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

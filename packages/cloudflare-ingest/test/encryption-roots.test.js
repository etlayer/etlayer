import assert from "node:assert/strict";
import test from "node:test";

import {
  EncryptionRootConfigurationError,
  activeEncryptionRootVersion,
  encryptionRootEnvName,
  resolveEncryptionRootKey,
} from "../src/encryption-roots.js";

test("defaults active encryption roots to v1 for compatibility", () => {
  assert.equal(
    activeEncryptionRootVersion({}, "destination"),
    "v1",
  );
  assert.equal(
    activeEncryptionRootVersion({}, "idempotency"),
    "v1",
  );
});

test("supports explicit v2 active version per domain", () => {
  const env = {
    ETLAYER_DESTINATION_SECRET_ACTIVE_VERSION: "v2",
    ETLAYER_IDEMPOTENCY_SECRET_ACTIVE_VERSION: "V2",
  };

  assert.equal(
    activeEncryptionRootVersion(env, "destination"),
    "v2",
  );
  assert.equal(
    activeEncryptionRootVersion(env, "idempotency"),
    "v2",
  );
});

test("maps domain and version to explicit root environment names", () => {
  assert.equal(
    encryptionRootEnvName("destination", "v1"),
    "ETLAYER_DESTINATION_SECRET_KEY_V1",
  );
  assert.equal(
    encryptionRootEnvName("destination", "v2"),
    "ETLAYER_DESTINATION_SECRET_KEY_V2",
  );
  assert.equal(
    encryptionRootEnvName("idempotency", "v1"),
    "ETLAYER_IDEMPOTENCY_SECRET_KEY_V1",
  );
  assert.equal(
    encryptionRootEnvName("idempotency", "v2"),
    "ETLAYER_IDEMPOTENCY_SECRET_KEY_V2",
  );
});

test("imports both v1 and v2 roots independently", async () => {
  const env = {
    ETLAYER_DESTINATION_SECRET_KEY_V1:
      "11".repeat(32),
    ETLAYER_DESTINATION_SECRET_KEY_V2:
      "22".repeat(32),
  };

  const v1 = await resolveEncryptionRootKey(env, {
    domain: "destination",
    version: "v1",
  });
  const v2 = await resolveEncryptionRootKey(env, {
    domain: "destination",
    version: "v2",
  });

  assert.equal(v1.type, "secret");
  assert.equal(v2.type, "secret");
});

test("rejects unsupported active version and missing historical root", async () => {
  assert.throws(
    () =>
      activeEncryptionRootVersion(
        {
          ETLAYER_DESTINATION_SECRET_ACTIVE_VERSION:
            "v3",
        },
        "destination",
      ),
    EncryptionRootConfigurationError,
  );

  await assert.rejects(
    resolveEncryptionRootKey(
      {
        ETLAYER_DESTINATION_SECRET_KEY_V2:
          "22".repeat(32),
      },
      {
        domain: "destination",
        version: "v1",
      },
    ),
    EncryptionRootConfigurationError,
  );
});

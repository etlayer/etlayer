import assert from "node:assert/strict";
import test from "node:test";

import {
  handleEventInspect,
} from "../src/inspect-http.js";
import {
  handlePublicApiRequest,
} from "../src/public-api.js";
import {
  createRegistryProject,
  credentialFingerprint,
} from "../src/registry.js";
import {
  validationStateKey,
} from "../src/validation-state.js";
import {
  writeContractOwnership,
} from "../src/contract-ownership.js";

function fakeArchive() {
  const objects = new Map();

  return {
    objects,
    async put(key, body, options = {}) {
      objects.set(key, {
        body,
        customMetadata:
          options.customMetadata || {},
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
    async list({ prefix = "" } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) =>
            key.startsWith(prefix),
          )
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}

test("internal and public event inspection expose current ownership", async () => {
  const archive = fakeArchive();
  const projectId = "ownership-view";
  const eventId = "evt-owned-1";
  const operatorCredential =
    "etl_op_ownership-view";
  const fingerprint =
    await credentialFingerprint(
      operatorCredential,
    );

  await createRegistryProject(
    archive,
    {
      projectId,
      operatorFingerprint:
        fingerprint,
      now: new Date(
        "2026-09-25T21:00:00Z",
      ),
    },
  );

  await archive.put(
    validationStateKey(
      eventId,
      projectId,
    ),
    JSON.stringify({
      version: 4,
      projectId,
      eventId,
      eventName:
        "account.created",
      validatorVersion: 2,
      schemaVersion: 1,
      status: "valid",
      contractId:
        "account.created@1",
      contractStatus: null,
      governanceManifestDigest: null,
      errors: [],
      sourceKey:
        "projects/ownership-view/events/example.json",
      updatedAt:
        "2026-09-25T21:00:01.000Z",
    }),
  );

  const before = await handleEventInspect(
    new Request(
      "https://events.test/_ops/inspect",
      {
        method: "POST",
        headers: {
          authorization:
            "Bearer " +
            operatorCredential,
          "content-type":
            "application/json",
        },
        body: JSON.stringify({
          projectId,
          eventId,
        }),
      },
    ),
    { ARCHIVE: archive },
  );

  assert.equal(before.status, 200);
  assert.equal(
    (await before.json()).ownership,
    null,
  );

  await writeContractOwnership(
    archive,
    {
      projectId,
      eventName:
        "account.created",
      team: "accounts-platform",
      domain: "accounts",
      contacts: [
        {
          kind: "email",
          value:
            "accounts@example.com",
        },
      ],
    },
    {
      now: new Date(
        "2026-09-25T21:05:00Z",
      ),
    },
  );

  const inspected =
    await handleEventInspect(
      new Request(
        "https://events.test/_ops/inspect",
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer " +
              operatorCredential,
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            projectId,
            eventId,
          }),
        },
      ),
      { ARCHIVE: archive },
    );

  assert.equal(
    inspected.status,
    200,
  );

  const internal =
    await inspected.json();

  assert.equal(
    internal.ownership.team,
    "accounts-platform",
  );
  assert.equal(
    internal.ownership.domain,
    "accounts",
  );

  const publicResponse =
    await handlePublicApiRequest(
      new Request(
        "https://events.test/api/v1/projects/ownership-view/events/evt-owned-1",
        {
          method: "GET",
          headers: {
            authorization:
              "Bearer " +
              operatorCredential,
          },
        },
      ),
      { ARCHIVE: archive },
    );

  assert.equal(
    publicResponse.status,
    200,
  );

  const publicBody =
    await publicResponse.json();

  assert.equal(
    publicBody.ownership.team,
    "accounts-platform",
  );
  assert.equal(
    publicBody.ownership.contacts[0]
      .value,
    "accounts@example.com",
  );
});

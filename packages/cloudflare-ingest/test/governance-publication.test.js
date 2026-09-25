import assert from "node:assert/strict";
import test from "node:test";

import {
  governanceManifestDigest,
} from "../src/governance-manifest.js";
import {
  GovernancePublicationBreakingChangeError,
  GovernancePublicationDigestMismatchError,
  governanceContractKey,
  governancePublicationKey,
  publishGovernanceManifest,
  readGovernancePublication,
  readPublishedContract,
  resolvePublishedContractForEvent,
} from "../src/governance-publication.js";

function archive() {
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
  };
}

function manifest() {
  return {
    apiVersion: "etlayer.dev/v1",
    kind: "ProjectGovernance",
    projectId: "project-a",
    contracts: [
      {
        eventName: "account.created",
        currentVersion: 1,
        compatibilityMode: "backward",
        proposedContract: {
          id: "account.created@2",
          eventName: "account.created",
          version: 2,
          required: {
            "account.id": {
              type: "string",
            },
            "plan.id": {
              type: "string",
            },
          },
          forbidden: [],
        },
        from:
          "2026-09-25T10:00:00Z",
        to:
          "2026-09-25T11:00:00Z",
      },
    ],
  };
}

async function publicationInput(
  overrides = {},
) {
  const value = manifest();
  const digest =
    await governanceManifestDigest(
      value,
    );

  return {
    manifest: value,
    manifestDigest: digest,
    acknowledgeBreaking: true,
    plan: {
      version: 1,
      manifestDigest: digest,
      projectId: "project-a",
      compatible: false,
      selected: 2,
      changed: 1,
    },
    ...overrides,
  };
}

test("rejects publication when supplied digest does not match normalized manifest", async () => {
  const store = archive();

  await assert.rejects(
    () =>
      publishGovernanceManifest(
        store,
        {
          ...(await publicationInput()),
          manifestDigest:
            "0".repeat(64),
        },
      ),
    GovernancePublicationDigestMismatchError,
  );

  assert.equal(
    store.objects.size,
    0,
  );
});

test("requires explicit acknowledgement for a breaking plan", async () => {
  const store = archive();

  await assert.rejects(
    () =>
      publishGovernanceManifest(
        store,
        await publicationInput({
          acknowledgeBreaking: false,
        }),
      ),
    GovernancePublicationBreakingChangeError,
  );

  assert.equal(
    store.objects.size,
    0,
  );
});

test("publishes immutable contracts and one idempotent publication record", async () => {
  const store = archive();
  const input =
    await publicationInput();

  const first =
    await publishGovernanceManifest(
      store,
      input,
      {
        now: new Date(
          "2026-09-25T12:00:00Z",
        ),
      },
    );

  const second =
    await publishGovernanceManifest(
      store,
      input,
      {
        now: new Date(
          "2026-09-25T12:05:00Z",
        ),
      },
    );

  assert.equal(first.created, true);
  assert.equal(second.created, false);

  const contractKey =
    governanceContractKey(
      "project-a",
      "account.created",
      2,
    );
  const publicationKey =
    governancePublicationKey(
      "project-a",
      input.manifestDigest,
    );

  assert.equal(
    store.objects.has(contractKey),
    true,
  );
  assert.equal(
    store.objects.has(publicationKey),
    true,
  );
  assert.equal(
    store.objects.size,
    2,
  );

  const publication =
    await readGovernancePublication(
      store,
      "project-a",
      input.manifestDigest,
    );

  assert.equal(
    publication.manifestDigest,
    input.manifestDigest,
  );
  assert.equal(
    publication.publishedAt,
    "2026-09-25T12:00:00.000Z",
  );

  const published =
    await readPublishedContract(
      store,
      "project-a",
      "account.created",
      2,
    );

  assert.equal(
    published.contract.id,
    "account.created@2",
  );
  assert.equal(
    published.manifestDigest,
    input.manifestDigest,
  );
});

test("resolves an exact project-published schema version for runtime validation", async () => {
  const store = archive();
  const input =
    await publicationInput();

  await publishGovernanceManifest(
    store,
    input,
  );

  const resolved =
    await resolvePublishedContractForEvent(
      store,
      {
        id: "evt-1",
        eventName:
          "account.created",
        provenance: {
          version: 2,
          projectId:
            "project-a",
          profileId: "backend",
          producer: {
            kind: "backend",
          },
          allowedAuthorityKinds: [
            "business_state",
          ],
        },
        logRecord: {
          attributes: [
            {
              key:
                "etlayer.schema.version",
              value: {
                intValue: "2",
              },
            },
          ],
        },
      },
    );

  assert.equal(
    resolved.contract.version,
    2,
  );
  assert.equal(
    resolved.contract.eventName,
    "account.created",
  );
});

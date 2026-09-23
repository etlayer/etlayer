import assert from "node:assert/strict";
import test from "node:test";

import { authorityStateKey } from "../src/authority-state.js";
import {
  decisionHistoryKey,
  latestDecisionKey,
} from "../src/decision-history.js";
import { deliveryStateKey } from "../src/delivery-state.js";
import { handleEventInspect } from "../src/inspect-http.js";
import { identityStateKey } from "../src/identity-state.js";
import { privacyStateKey } from "../src/privacy-state.js";
import {
  createRegistryProject,
  credentialFingerprint,
  setRegistryDestination,
} from "../src/registry.js";
import { validationStateKey } from "../src/validation-state.js";

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

async function createDynamicProject(
  archive,
  projectId,
  operatorCredential,
) {
  const fingerprint =
    await credentialFingerprint(operatorCredential);

  await createRegistryProject(archive, {
    projectId,
    operatorFingerprint: fingerprint,
    now: new Date("2026-09-23T04:00:00.000Z"),
  });

  await setRegistryDestination(archive, {
    projectId,
    destination: "posthog",
    enabled: true,
    now: new Date("2026-09-23T04:00:01.000Z"),
  });
}

function inspectRequest(
  projectId,
  eventId,
  operatorCredential,
) {
  return new Request(
    "https://events.test/_ops/inspect",
    {
      method: "POST",
      headers: {
        authorization:
          "Bearer " + operatorCredential,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        eventId,
      }),
    },
  );
}

async function putJson(archive, key, value) {
  await archive.put(
    key,
    JSON.stringify(value),
    {
      httpMetadata: {
        contentType:
          "application/json; charset=utf-8",
      },
    },
  );
}

test("assembles complete event evidence by projectId and eventId only", async () => {
  const archive = fakeArchive();
  const projectId = "external-a";
  const eventId = "evt-onboarding-1";
  const operatorCredential = "etl_op_external-a";
  const sourceKey =
    "projects/external-a/events/2026/09/23/04/evt-onboarding-1.json";
  const decisionId = "decision-1";

  await createDynamicProject(
    archive,
    projectId,
    operatorCredential,
  );

  await putJson(
    archive,
    validationStateKey(eventId, projectId),
    {
      version: 2,
      projectId,
      eventId,
      eventName: "account.created",
      validatorVersion: 1,
      schemaVersion: 1,
      status: "valid",
      contractId: "account.created@1",
      errors: [],
      sourceKey,
      updatedAt: "2026-09-23T04:01:00.000Z",
    },
  );

  await putJson(
    archive,
    authorityStateKey(eventId, projectId),
    {
      version: 2,
      projectId,
      eventId,
      eventName: "account.created",
      status: "allowed",
      policyVersion: 1,
      profileId: "backend",
      trustedProducerKind: "backend",
      claim: {
        producerKind: "backend",
        authorityKind: "business_state",
      },
      errors: [],
      sourceKey,
      updatedAt: "2026-09-23T04:01:00.000Z",
    },
  );

  await putJson(
    archive,
    privacyStateKey(eventId, projectId),
    {
      version: 2,
      projectId,
      eventId,
      eventName: "account.created",
      policyVersion: 1,
      status: "clean",
      sourceKey,
      ingestActions: [],
      deliveryActions: [],
      updatedAt: "2026-09-23T04:01:00.000Z",
    },
  );

  await putJson(
    archive,
    identityStateKey(eventId, projectId),
    {
      version: 3,
      projectId,
      eventId,
      eventName: "account.created",
      status: "resolved",
      subject: {
        kind: "anonymous",
        id: "anon_external_onboarding",
      },
      actor: {
        type: "anonymous",
        id: "anon_external_onboarding",
        source: "inferred",
      },
      delegation: [],
      anonymousId: "anon_external_onboarding",
      userId: null,
      accountId: "account_external_onboarding",
      sessionId: null,
      transition: null,
      agent: {
        turnId: null,
        toolCallId: null,
      },
      attribution: {
        source: null,
        medium: null,
        campaign: null,
      },
      sourceKey,
      updatedAt: "2026-09-23T04:01:00.000Z",
    },
  );

  await putJson(
    archive,
    decisionHistoryKey(
      eventId,
      decisionId,
      projectId,
    ),
    {
      version: 2,
      projectId,
      decisionId,
      eventId,
      eventName: "account.created",
      evaluationKind: "processing",
      sourceKey,
      evaluatedAt: "2026-09-23T04:01:00.000Z",
      provenance: {
        version: 2,
        projectId,
        profileId: "backend",
        producerKind: "backend",
      },
      validation: {
        status: "valid",
        validatorVersion: 1,
        schemaVersion: 1,
        contractId: "account.created@1",
        errors: [],
      },
      authority: {
        status: "allowed",
        policyVersion: 1,
        profileId: "backend",
        trustedProducerKind: "backend",
        claim: {
          producerKind: "backend",
          authorityKind: "business_state",
        },
        errors: [],
      },
      privacy: {
        status: "clean",
        policyVersion: 1,
        ingestActions: [],
        deliveryActions: [],
      },
      routeEligible: true,
    },
  );

  await putJson(
    archive,
    latestDecisionKey(eventId, projectId),
    {
      version: 2,
      projectId,
      eventId,
      decisionId,
      key: decisionHistoryKey(
        eventId,
        decisionId,
        projectId,
      ),
      evaluationKind: "processing",
      evaluatedAt: "2026-09-23T04:01:00.000Z",
    },
  );

  await putJson(
    archive,
    deliveryStateKey(
      "posthog",
      eventId,
      projectId,
    ),
    {
      version: 2,
      projectId,
      eventId,
      eventName: "account.created",
      destination: "posthog",
      status: "exported",
      updatedAt: "2026-09-23T04:01:01.000Z",
    },
  );

  const response = await handleEventInspect(
    inspectRequest(
      projectId,
      eventId,
      operatorCredential,
    ),
    { ARCHIVE: archive },
  );

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.projectId, projectId);
  assert.equal(body.eventId, eventId);
  assert.equal(body.status, "complete");
  assert.equal(body.known, true);
  assert.equal(body.sourceKey, sourceKey);
  assert.equal(body.validation.status, "valid");
  assert.equal(body.authority.status, "allowed");
  assert.equal(
    body.authority.trustedProducerKind,
    "backend",
  );
  assert.equal(body.privacy.status, "clean");
  assert.equal(body.identity.status, "resolved");
  assert.equal(body.decision.routeEligible, true);
  assert.deepEqual(
    body.deliveries.map(
      ({ destination, status }) => [
        destination,
        status,
      ],
    ),
    [["posthog", "exported"]],
  );
});

test("returns pending_or_unknown before any event evidence exists", async () => {
  const archive = fakeArchive();
  const operatorCredential = "etl_op_external-b";

  await createDynamicProject(
    archive,
    "external-b",
    operatorCredential,
  );

  const response = await handleEventInspect(
    inspectRequest(
      "external-b",
      "evt-not-yet-visible",
      operatorCredential,
    ),
    { ARCHIVE: archive },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "pending_or_unknown");
  assert.equal(body.known, false);
  assert.equal(body.sourceKey, null);
  assert.equal(body.decision, null);
  assert.deepEqual(
    body.deliveries.map(
      ({ destination, status }) => [
        destination,
        status,
      ],
    ),
    [["posthog", "pending"]],
  );
});

test("operator cannot inspect another dynamic project event", async () => {
  const archive = fakeArchive();

  await createDynamicProject(
    archive,
    "project-a",
    "etl_op_project-a",
  );
  await createDynamicProject(
    archive,
    "project-b",
    "etl_op_project-b",
  );

  const response = await handleEventInspect(
    inspectRequest(
      "project-a",
      "evt-1",
      "etl_op_project-b",
    ),
    { ARCHIVE: archive },
  );

  assert.equal(response.status, 401);
});

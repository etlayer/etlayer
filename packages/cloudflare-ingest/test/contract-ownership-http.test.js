import assert from "node:assert/strict";
import test from "node:test";

import {
  controlPlaneAuditKey,
} from "../src/control-plane-audit.js";
import {
  handleManagementRequest,
} from "../src/management-http.js";

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

async function manage(
  env,
  method,
  path,
  token,
  body,
) {
  const init = {
    method,
    headers: {
      authorization:
        "Bearer " + token,
    },
  };

  if (body !== undefined) {
    init.headers["content-type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }

  const request = new Request(
    "https://events.test" + path,
    init,
  );

  return handleManagementRequest(
    request,
    env,
    new URL(request.url),
  );
}

test("project operator configures normalized audited ownership metadata", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY:
      "management-key",
  };

  const project = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "ownership-a" },
    )
  ).json();

  const configured =
    await manage(
      env,
      "PUT",
      "/_mgmt/projects/ownership-a/contracts/account.created/ownership",
      project.operatorCredential,
      {
        team: "accounts-platform",
        domain: "accounts",
        contacts: [
          {
            kind: "slack",
            value: "#accounts-alerts",
          },
          {
            kind: "email",
            value:
              "Accounts@Example.com",
          },
        ],
      },
    );

  assert.equal(
    configured.status,
    200,
  );
  const operationId =
    configured.headers.get(
      "x-etlayer-operation-id",
    );
  assert.ok(operationId);

  const body =
    await configured.json();
  assert.equal(body.changed, true);
  assert.equal(
    body.ownership.team,
    "accounts-platform",
  );
  assert.deepEqual(
    body.ownership.contacts,
    [
      {
        kind: "email",
        value: "accounts@example.com",
      },
      {
        kind: "slack",
        value: "#accounts-alerts",
      },
    ],
  );

  const fetched = await manage(
    env,
    "GET",
    "/_mgmt/projects/ownership-a/contracts/account.created/ownership",
    project.operatorCredential,
  );

  assert.equal(fetched.status, 200);
  assert.deepEqual(
    (await fetched.json()).ownership,
    body.ownership,
  );

  const auditResponse =
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

  assert.equal(
    auditResponse.status,
    200,
  );

  const audit =
    await auditResponse.json();
  assert.equal(
    audit.action,
    "contract.ownership.configure",
  );
  assert.equal(
    audit.actor.kind,
    "project_operator",
  );
  assert.equal(
    audit.target.projectId,
    "ownership-a",
  );
  assert.equal(
    audit.target.eventName,
    "account.created",
  );
  assert.equal(
    audit.change.contactCount,
    2,
  );

  const serialized =
    JSON.stringify(audit);
  assert.equal(
    serialized.includes(
      "accounts@example.com",
    ),
    false,
  );
  assert.equal(
    serialized.includes(
      "#accounts-alerts",
    ),
    false,
  );

  const repeated =
    await manage(
      env,
      "PUT",
      "/_mgmt/projects/ownership-a/contracts/account.created/ownership",
      project.operatorCredential,
      {
        team: "accounts-platform",
        domain: "accounts",
        contacts: [
          {
            kind: "email",
            value:
              "accounts@example.com",
          },
          {
            kind: "slack",
            value: "#accounts-alerts",
          },
          {
            kind: "email",
            value:
              "Accounts@Example.com",
          },
        ],
      },
    );

  assert.equal(
    repeated.status,
    200,
  );
  assert.equal(
    (await repeated.json()).changed,
    false,
  );
});

test("another project operator cannot read or write ownership", async () => {
  const archive = fakeArchive();
  const env = {
    ARCHIVE: archive,
    ETLAYER_MANAGEMENT_KEY:
      "management-key",
  };

  const projectA = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "ownership-a" },
    )
  ).json();

  const projectB = await (
    await manage(
      env,
      "POST",
      "/_mgmt/projects",
      "management-key",
      { id: "ownership-b" },
    )
  ).json();

  const deniedWrite =
    await manage(
      env,
      "PUT",
      "/_mgmt/projects/ownership-a/contracts/account.created/ownership",
      projectB.operatorCredential,
      {
        team: "wrong-team",
        contacts: [],
      },
    );

  assert.equal(
    deniedWrite.status,
    401,
  );

  const allowedWrite =
    await manage(
      env,
      "PUT",
      "/_mgmt/projects/ownership-a/contracts/account.created/ownership",
      projectA.operatorCredential,
      {
        team: "accounts-platform",
        contacts: [],
      },
    );

  assert.equal(
    allowedWrite.status,
    200,
  );

  const deniedRead =
    await manage(
      env,
      "GET",
      "/_mgmt/projects/ownership-a/contracts/account.created/ownership",
      projectB.operatorCredential,
    );

  assert.equal(
    deniedRead.status,
    401,
  );
});

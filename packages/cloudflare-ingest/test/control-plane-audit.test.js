import assert from "node:assert/strict";
import test from "node:test";

import {
  auditControlPlaneMutation,
  controlPlaneAuditKey,
  readControlPlaneAudit,
} from "../src/control-plane-audit.js";

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

      objects.set(key, body);
      return { key };
    },
    async get(key) {
      const body = objects.get(key);
      if (body == null) return null;

      return {
        async text() {
          return body;
        },
      };
    },
  };
}

function descriptor() {
  return {
    actor: {
      kind: "project_operator",
      projectId: "customer-a",
      source: "registry",
      authorization: "Bearer should-never-persist",
    },
    action: "producer.rotate",
    target: {
      kind: "producer",
      projectId: "customer-a",
      producerId: "backend-main",
    },
    request: {
      method: "POST",
      path:
        "/_mgmt/projects/customer-a/producers/backend-main/rotate",
    },
    change: {
      kind: "credential_rotation",
      credential: "etl_prod_should-never-persist",
    },
  };
}

test("records append-only requested and applied phases around a successful mutation", async () => {
  const store = archive();

  const result = await auditControlPlaneMutation(
    store,
    descriptor(),
    async () => ({ status: "rotated" }),
    {
      operationId: "op-success",
      now: new Date("2026-09-24T13:20:00.000Z"),
    },
  );

  assert.deepEqual(result, {
    operationId: "op-success",
    value: { status: "rotated" },
  });

  const requested = await readControlPlaneAudit(
    store,
    "op-success",
    "requested",
  );
  const applied = await readControlPlaneAudit(
    store,
    "op-success",
    "applied",
  );

  assert.equal(requested.action, "producer.rotate");
  assert.equal(requested.actor.kind, "project_operator");
  assert.equal(requested.target.projectId, "customer-a");
  assert.equal(applied.phase, "applied");

  const persisted = [...store.objects.values()].join("\n");
  assert.equal(
    persisted.includes("Bearer should-never-persist"),
    false,
  );
  assert.equal(
    persisted.includes("etl_prod_should-never-persist"),
    false,
  );
});

test("records failed phase and rethrows a failed mutation", async () => {
  const store = archive();

  await assert.rejects(
    auditControlPlaneMutation(
      store,
      descriptor(),
      async () => {
        throw new Error("mutation failed");
      },
      {
        operationId: "op-failed",
        now: new Date("2026-09-24T13:21:00.000Z"),
      },
    ),
    /mutation failed/,
  );

  const requested = await readControlPlaneAudit(
    store,
    "op-failed",
    "requested",
  );
  const failed = await readControlPlaneAudit(
    store,
    "op-failed",
    "failed",
  );

  assert.equal(requested.phase, "requested");
  assert.equal(failed.phase, "failed");
  assert.deepEqual(failed.failure, {
    name: "Error",
  });
  assert.equal(
    await readControlPlaneAudit(
      store,
      "op-failed",
      "applied",
    ),
    null,
  );
});

test("audit keys are deterministic and phase-specific", () => {
  assert.equal(
    controlPlaneAuditKey("op:123", "requested"),
    "registry/audit/op%3A123/requested.json",
  );
  assert.equal(
    controlPlaneAuditKey("op:123", "applied"),
    "registry/audit/op%3A123/applied.json",
  );
});

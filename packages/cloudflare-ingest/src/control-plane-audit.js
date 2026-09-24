export const CONTROL_PLANE_AUDIT_VERSION = 1;

const AUDIT_PHASES = new Set([
  "requested",
  "applied",
  "failed",
]);

export async function auditControlPlaneMutation(
  archive,
  descriptor,
  mutate,
  options = {},
) {
  if (typeof mutate !== "function") {
    throw new ControlPlaneAuditConfigurationError(
      "audit mutation callback is required",
    );
  }

  const operationId =
    normalizeOperationId(options.operationId) ||
    options.crypto?.randomUUID?.() ||
    globalThis.crypto?.randomUUID?.();

  if (!operationId) {
    throw new ControlPlaneAuditConfigurationError(
      "audit operation id could not be generated",
    );
  }

  const recordedAt = normalizeNow(options.now);
  const base = normalizeDescriptor(descriptor);

  await recordControlPlaneAudit(
    archive,
    {
      ...base,
      operationId,
      phase: "requested",
      recordedAt,
    },
  );

  try {
    const value = await mutate();

    await recordControlPlaneAudit(
      archive,
      {
        ...base,
        operationId,
        phase: "applied",
        recordedAt: normalizeNow(options.now),
      },
    );

    return { operationId, value };
  } catch (error) {
    await recordControlPlaneAudit(
      archive,
      {
        ...base,
        operationId,
        phase: "failed",
        recordedAt: normalizeNow(options.now),
        failure: {
          name:
            error instanceof Error
              ? error.name
              : "UnknownError",
        },
      },
    );

    throw error;
  }
}

export async function recordControlPlaneAudit(
  archive,
  entry,
) {
  requireArchive(archive);

  if (!AUDIT_PHASES.has(entry?.phase)) {
    throw new ControlPlaneAuditConfigurationError(
      "audit phase must be requested, applied, or failed",
    );
  }

  const operationId = normalizeOperationId(
    entry.operationId,
  );

  if (!operationId) {
    throw new ControlPlaneAuditConfigurationError(
      "audit operation id is required",
    );
  }

  const state = {
    version: CONTROL_PLANE_AUDIT_VERSION,
    operationId,
    phase: entry.phase,
    recordedAt: normalizeTimestamp(entry.recordedAt),
    actor: sanitizeAuditValue(entry.actor),
    action: normalizeNonEmptyString(
      entry.action,
      "audit action",
    ),
    target: sanitizeAuditValue(entry.target),
    request: sanitizeAuditValue(entry.request),
    change: sanitizeAuditValue(entry.change),
    ...(entry.failure
      ? { failure: sanitizeAuditValue(entry.failure) }
      : {}),
  };

  const key = controlPlaneAuditKey(
    operationId,
    entry.phase,
  );

  const stored = await archive.put(
    key,
    JSON.stringify(state),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
      customMetadata: {
        kind: "control_plane_audit",
        operation_id: operationId,
        phase: entry.phase,
        action: state.action,
        project_id:
          state.target?.projectId ||
          state.actor?.projectId ||
          "",
        recorded_at: state.recordedAt,
      },
    },
  );

  if (stored === null) {
    throw new ControlPlaneAuditConflictError(
      `audit evidence already exists: ${key}`,
    );
  }

  return { key, state };
}

export async function readControlPlaneAudit(
  archive,
  operationId,
  phase,
) {
  if (!archive || typeof archive.get !== "function") {
    return null;
  }

  const object = await archive.get(
    controlPlaneAuditKey(operationId, phase),
  );
  if (!object) return null;

  const text =
    typeof object.text === "function"
      ? await object.text()
      : object.body != null
        ? await new Response(object.body).text()
        : null;

  if (text == null) {
    throw new ControlPlaneAuditConfigurationError(
      "audit evidence has no readable body",
    );
  }

  return JSON.parse(text);
}

export function controlPlaneAuditKey(
  operationId,
  phase,
) {
  const normalized = normalizeOperationId(operationId);

  if (!normalized) {
    throw new ControlPlaneAuditConfigurationError(
      "audit operation id is required",
    );
  }

  if (!AUDIT_PHASES.has(phase)) {
    throw new ControlPlaneAuditConfigurationError(
      "audit phase is invalid",
    );
  }

  return (
    "registry/audit/" +
    encodeURIComponent(normalized) +
    "/" +
    phase +
    ".json"
  );
}

function normalizeDescriptor(value) {
  if (!value || typeof value !== "object") {
    throw new ControlPlaneAuditConfigurationError(
      "audit descriptor is required",
    );
  }

  return {
    actor: sanitizeAuditValue(value.actor),
    action: normalizeNonEmptyString(
      value.action,
      "audit action",
    ),
    target: sanitizeAuditValue(value.target),
    request: sanitizeAuditValue(value.request),
    change: sanitizeAuditValue(value.change),
  };
}

function sanitizeAuditValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeAuditValue);
  }

  if (value && typeof value === "object") {
    const result = {};

    for (const [key, item] of Object.entries(value)) {
      if (
        /secret|credential|authorization|ciphertext|token/i.test(
          key,
        )
      ) {
        continue;
      }

      result[key] = sanitizeAuditValue(item);
    }

    return result;
  }

  return value ?? null;
}

function normalizeNow(value) {
  const date =
    value instanceof Date
      ? value
      : new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new ControlPlaneAuditConfigurationError(
      "audit timestamp is invalid",
    );
  }

  return date.toISOString();
}

function normalizeTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new ControlPlaneAuditConfigurationError(
      "audit recordedAt is invalid",
    );
  }

  return date.toISOString();
}

function normalizeOperationId(value) {
  if (value == null) return null;

  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new ControlPlaneAuditConfigurationError(
      "audit operation id is invalid",
    );
  }

  return value;
}

function normalizeNonEmptyString(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new ControlPlaneAuditConfigurationError(
      `${label} must be a non-empty string`,
    );
  }

  return value;
}

function requireArchive(archive) {
  if (
    !archive ||
    typeof archive.put !== "function"
  ) {
    throw new ControlPlaneAuditConfigurationError(
      "archive bucket is not configured for control-plane audit",
    );
  }
}

export class ControlPlaneAuditConfigurationError extends Error {}
export class ControlPlaneAuditConflictError extends Error {}

export const CONTRACT_LIFECYCLE_VERSION = 1;

const STATUSES = new Set([
  "published",
  "deprecated",
  "retired",
]);

export async function ensureContractLifecycle(
  archive,
  input,
  options = {},
) {
  requireArchive(archive);

  const normalized =
    normalizeIdentity(input);
  const key = contractLifecycleKey(
    normalized.projectId,
    normalized.eventName,
    normalized.contractVersion,
  );
  const existing =
    await readContractLifecycle(
      archive,
      normalized.projectId,
      normalized.eventName,
      normalized.contractVersion,
    );

  if (existing) {
    return {
      created: false,
      key,
      state: existing,
    };
  }

  const publishedAt = normalizeDate(
    input?.publishedAt ||
      options.now,
    "publishedAt",
  ).toISOString();

  const state = {
    version:
      CONTRACT_LIFECYCLE_VERSION,
    projectId:
      normalized.projectId,
    eventName:
      normalized.eventName,
    contractVersion:
      normalized.contractVersion,
    contractId:
      normalizeContractId(
        input?.contractId,
      ),
    manifestDigest:
      normalizeManifestDigest(
        input?.manifestDigest,
      ),
    status: "published",
    publishedAt,
    updatedAt: publishedAt,
    deprecatedAt: null,
    retiredAt: null,
  };

  const stored = await putCreateOnly(
    archive,
    key,
    state,
  );

  if (!stored) {
    const raced =
      await readContractLifecycle(
        archive,
        normalized.projectId,
        normalized.eventName,
        normalized.contractVersion,
      );

    if (!raced) {
      throw new ContractLifecycleConfigurationError(
        `contract lifecycle could not be read after create race: ${key}`,
      );
    }

    return {
      created: false,
      key,
      state: raced,
    };
  }

  return {
    created: true,
    key,
    state,
  };
}

export async function transitionContractLifecycle(
  archive,
  input,
  options = {},
) {
  requireArchive(archive);

  const normalized =
    normalizeIdentity(input);
  const toStatus =
    normalizeStatus(input?.toStatus);

  let current =
    await readContractLifecycle(
      archive,
      normalized.projectId,
      normalized.eventName,
      normalized.contractVersion,
    );

  if (!current) {
    if (
      !input?.publishedAt ||
      !input?.manifestDigest
    ) {
      throw new ContractLifecycleNotFoundError(
        `contract lifecycle not found: ${normalized.projectId}/${normalized.eventName}@${normalized.contractVersion}`,
      );
    }

    current = (
      await ensureContractLifecycle(
        archive,
        {
          ...normalized,
          contractId:
            input.contractId,
          manifestDigest:
            input.manifestDigest,
          publishedAt:
            input.publishedAt,
        },
        options,
      )
    ).state;
  }

  if (current.status === toStatus) {
    return {
      changed: false,
      key: contractLifecycleKey(
        normalized.projectId,
        normalized.eventName,
        normalized.contractVersion,
      ),
      state: current,
    };
  }

  assertTransition(
    current.status,
    toStatus,
  );

  const now = normalizeDate(
    options.now,
    "lifecycle transition time",
  ).toISOString();
  const next = {
    ...current,
    status: toStatus,
    updatedAt: now,
    ...(toStatus === "deprecated"
      ? { deprecatedAt: now }
      : {}),
    ...(toStatus === "retired"
      ? { retiredAt: now }
      : {}),
  };

  const key = contractLifecycleKey(
    normalized.projectId,
    normalized.eventName,
    normalized.contractVersion,
  );

  await archive.put(
    key,
    JSON.stringify(next),
    {
      httpMetadata: {
        contentType:
          "application/json; charset=utf-8",
      },
      customMetadata:
        lifecycleMetadata(next),
    },
  );

  return {
    changed: true,
    key,
    state: next,
  };
}

export async function readContractLifecycle(
  archive,
  projectId,
  eventName,
  contractVersion,
) {
  if (
    !archive ||
    typeof archive.get !== "function"
  ) {
    return null;
  }

  const key = contractLifecycleKey(
    projectId,
    eventName,
    contractVersion,
  );
  const object = await archive.get(key);

  if (!object) return null;

  const text =
    typeof object.text === "function"
      ? await object.text()
      : object.body != null
        ? await new Response(
            object.body,
          ).text()
        : null;

  if (text == null) {
    throw new ContractLifecycleConfigurationError(
      `contract lifecycle has no readable body: ${key}`,
    );
  }

  let state;

  try {
    state = JSON.parse(text);
  } catch {
    throw new ContractLifecycleConfigurationError(
      `contract lifecycle is not valid JSON: ${key}`,
    );
  }

  validateStoredLifecycle(
    state,
    projectId,
    eventName,
    contractVersion,
    key,
  );

  return state;
}

export function contractLifecycleKey(
  projectId,
  eventName,
  contractVersion,
) {
  validateProjectId(projectId);
  validateEventName(eventName);

  if (
    !Number.isSafeInteger(
      contractVersion,
    ) ||
    contractVersion < 1
  ) {
    throw new ContractLifecycleValidationError(
      "contractVersion must be a positive integer",
    );
  }

  return (
    "registry/governance/" +
    encodeURIComponent(projectId) +
    "/contract-lifecycle/" +
    encodeURIComponent(eventName) +
    "/" +
    String(contractVersion) +
    ".json"
  );
}

function assertTransition(
  fromStatus,
  toStatus,
) {
  const allowed =
    (fromStatus === "published" &&
      toStatus === "deprecated") ||
    (fromStatus === "deprecated" &&
      toStatus === "retired");

  if (!allowed) {
    throw new ContractLifecycleTransitionError(
      `contract lifecycle transition is not allowed: ${fromStatus} -> ${toStatus}`,
    );
  }
}

function normalizeIdentity(input) {
  validateProjectId(input?.projectId);
  validateEventName(input?.eventName);

  if (
    !Number.isSafeInteger(
      input?.contractVersion,
    ) ||
    input.contractVersion < 1
  ) {
    throw new ContractLifecycleValidationError(
      "contractVersion must be a positive integer",
    );
  }

  return {
    projectId: input.projectId,
    eventName: input.eventName,
    contractVersion:
      input.contractVersion,
  };
}

function normalizeStatus(value) {
  if (!STATUSES.has(value)) {
    throw new ContractLifecycleValidationError(
      "toStatus must be published, deprecated, or retired",
    );
  }

  return value;
}

function normalizeContractId(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new ContractLifecycleValidationError(
      "contractId must be a non-empty string",
    );
  }

  return value;
}

function normalizeManifestDigest(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{64}$/.test(value)
  ) {
    throw new ContractLifecycleValidationError(
      "manifestDigest must be sha256 hex",
    );
  }

  return value;
}

function normalizeDate(
  value,
  label,
) {
  const date =
    value instanceof Date
      ? value
      : new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new ContractLifecycleValidationError(
      `${label} is invalid`,
    );
  }

  return date;
}

function validateStoredLifecycle(
  state,
  projectId,
  eventName,
  contractVersion,
  key,
) {
  if (
    !state ||
    state.version !==
      CONTRACT_LIFECYCLE_VERSION ||
    state.projectId !== projectId ||
    state.eventName !== eventName ||
    state.contractVersion !==
      contractVersion ||
    !STATUSES.has(state.status)
  ) {
    throw new ContractLifecycleConfigurationError(
      `contract lifecycle does not match requested contract: ${key}`,
    );
  }
}

async function putCreateOnly(
  archive,
  key,
  state,
) {
  const stored = await archive.put(
    key,
    JSON.stringify(state),
    {
      onlyIf: {
        etagDoesNotMatch: "*",
      },
      httpMetadata: {
        contentType:
          "application/json; charset=utf-8",
      },
      customMetadata:
        lifecycleMetadata(state),
    },
  );

  return stored !== null;
}

function lifecycleMetadata(state) {
  return {
    kind: "contract_lifecycle",
    project_id: state.projectId,
    event_name: state.eventName,
    contract_version: String(
      state.contractVersion,
    ),
    contract_id:
      state.contractId || "",
    status: state.status,
    manifest_digest:
      state.manifestDigest || "",
    updated_at: state.updatedAt,
  };
}

function validateProjectId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(
      value,
    )
  ) {
    throw new ContractLifecycleValidationError(
      "projectId must be a lowercase slug",
    );
  }
}

function validateEventName(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new ContractLifecycleValidationError(
      "eventName must be a non-empty string",
    );
  }
}

function requireArchive(archive) {
  if (
    !archive ||
    typeof archive.get !== "function" ||
    typeof archive.put !== "function"
  ) {
    throw new ContractLifecycleConfigurationError(
      "archive bucket is not configured for contract lifecycle",
    );
  }
}

export class ContractLifecycleValidationError extends Error {}
export class ContractLifecycleNotFoundError extends Error {}
export class ContractLifecycleTransitionError extends Error {}
export class ContractLifecycleConfigurationError extends Error {}

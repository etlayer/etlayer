export const CONTRACT_OWNERSHIP_VERSION = 1;

const CONTACT_KINDS = new Set([
  "email",
  "slack",
  "url",
]);

export function normalizeContractOwnership(
  input = {},
) {
  const projectId =
    normalizeSlug(
      input.projectId,
      "projectId",
    );
  const eventName =
    normalizeEventName(
      input.eventName,
    );
  const team = normalizeSlug(
    input.team,
    "team",
  );
  const domain =
    input.domain == null ||
    input.domain === ""
      ? null
      : normalizeSlug(
          input.domain,
          "domain",
        );
  const contacts =
    normalizeContacts(
      input.contacts || [],
    );

  return {
    version: CONTRACT_OWNERSHIP_VERSION,
    projectId,
    eventName,
    team,
    domain,
    contacts,
  };
}

export async function writeContractOwnership(
  archive,
  input,
  options = {},
) {
  requireArchive(archive);

  const normalized =
    normalizeContractOwnership(input);
  const key =
    contractOwnershipKey(
      normalized.projectId,
      normalized.eventName,
    );
  const current =
    await readContractOwnership(
      archive,
      normalized.projectId,
      normalized.eventName,
    );

  if (
    current &&
    sameOwnership(
      current,
      normalized,
    )
  ) {
    return {
      changed: false,
      key,
      state: current,
    };
  }

  const updatedAt =
    normalizeDate(
      options.now,
      "updatedAt",
    ).toISOString();

  const state = {
    ...normalized,
    updatedAt,
  };

  await archive.put(
    key,
    JSON.stringify(state),
    {
      httpMetadata: {
        contentType:
          "application/json; charset=utf-8",
      },
      customMetadata: {
        kind:
          "contract_ownership",
        project_id:
          normalized.projectId,
        event_name:
          normalized.eventName,
        team: normalized.team,
        domain:
          normalized.domain || "",
        contact_count: String(
          normalized.contacts.length,
        ),
        updated_at: updatedAt,
      },
    },
  );

  return {
    changed: true,
    key,
    state,
  };
}

export async function readContractOwnership(
  archive,
  projectId,
  eventName,
) {
  if (
    !archive ||
    typeof archive.get !== "function"
  ) {
    return null;
  }

  const key =
    contractOwnershipKey(
      projectId,
      eventName,
    );
  const object =
    await archive.get(key);

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
    throw new ContractOwnershipConfigurationError(
      `contract ownership has no readable body: ${key}`,
    );
  }

  let state;

  try {
    state = JSON.parse(text);
  } catch {
    throw new ContractOwnershipConfigurationError(
      `contract ownership is not valid JSON: ${key}`,
    );
  }

  const normalized =
    normalizeContractOwnership(
      state,
    );

  if (
    state.version !==
      CONTRACT_OWNERSHIP_VERSION ||
    normalized.projectId !==
      projectId ||
    normalized.eventName !==
      eventName ||
    typeof state.updatedAt !==
      "string"
  ) {
    throw new ContractOwnershipConfigurationError(
      `contract ownership does not match requested resource: ${key}`,
    );
  }

  return {
    ...normalized,
    updatedAt:
      normalizeDate(
        state.updatedAt,
        "updatedAt",
      ).toISOString(),
  };
}

export function contractOwnershipKey(
  projectId,
  eventName,
) {
  const normalizedProject =
    normalizeSlug(
      projectId,
      "projectId",
    );
  const normalizedEvent =
    normalizeEventName(
      eventName,
    );

  return (
    "registry/governance/" +
    encodeURIComponent(
      normalizedProject,
    ) +
    "/ownership/" +
    encodeURIComponent(
      normalizedEvent,
    ) +
    ".json"
  );
}

function normalizeContacts(contacts) {
  if (!Array.isArray(contacts)) {
    throw new ContractOwnershipValidationError(
      "contacts must be an array",
    );
  }

  if (contacts.length > 25) {
    throw new ContractOwnershipValidationError(
      "contacts must contain at most 25 entries",
    );
  }

  const normalized = contacts.map(
    normalizeContact,
  );
  const unique = new Map();

  for (const contact of normalized) {
    unique.set(
      contact.kind +
        "\u0000" +
        contact.value,
      contact,
    );
  }

  const result = [
    ...unique.values(),
  ].sort((left, right) => {
    const kind =
      left.kind.localeCompare(
        right.kind,
      );

    if (kind !== 0) return kind;

    return left.value.localeCompare(
      right.value,
    );
  });

  if (result.length > 10) {
    throw new ContractOwnershipValidationError(
      "normalized contacts must contain at most 10 unique entries",
    );
  }

  return result;
}

function normalizeContact(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new ContractOwnershipValidationError(
      "contact must be an object",
    );
  }

  if (!CONTACT_KINDS.has(input.kind)) {
    throw new ContractOwnershipValidationError(
      "contact kind must be email, slack, or url",
    );
  }

  if (
    typeof input.value !== "string" ||
    input.value.trim() === ""
  ) {
    throw new ContractOwnershipValidationError(
      "contact value must be a non-empty string",
    );
  }

  let value = input.value.trim();

  if (value.length > 512) {
    throw new ContractOwnershipValidationError(
      "contact value is too long",
    );
  }

  if (input.kind === "email") {
    value = value.toLowerCase();

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        value,
      )
    ) {
      throw new ContractOwnershipValidationError(
        "email contact is invalid",
      );
    }
  }

  if (input.kind === "url") {
    let url;

    try {
      url = new URL(value);
    } catch {
      throw new ContractOwnershipValidationError(
        "url contact is invalid",
      );
    }

    if (
      url.protocol !== "https:" &&
      url.protocol !== "http:"
    ) {
      throw new ContractOwnershipValidationError(
        "url contact must use http or https",
      );
    }

    value = url.toString();
  }

  return {
    kind: input.kind,
    value,
  };
}

function sameOwnership(
  current,
  normalized,
) {
  return (
    current.team ===
      normalized.team &&
    current.domain ===
      normalized.domain &&
    JSON.stringify(
      current.contacts,
    ) ===
      JSON.stringify(
        normalized.contacts,
      )
  );
}

function normalizeSlug(
  value,
  label,
) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(
      value,
    )
  ) {
    throw new ContractOwnershipValidationError(
      `${label} must be a lowercase slug`,
    );
  }

  if (value.length > 128) {
    throw new ContractOwnershipValidationError(
      `${label} is too long`,
    );
  }

  return value;
}

function normalizeEventName(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new ContractOwnershipValidationError(
      "eventName must be a non-empty string",
    );
  }

  const normalized = value.trim();

  if (
    normalized.length > 256 ||
    !/^[A-Za-z0-9._-]+$/.test(
      normalized,
    )
  ) {
    throw new ContractOwnershipValidationError(
      "eventName contains unsupported characters",
    );
  }

  return normalized;
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
    throw new ContractOwnershipValidationError(
      `${label} is invalid`,
    );
  }

  return date;
}

function requireArchive(archive) {
  if (
    !archive ||
    typeof archive.get !== "function" ||
    typeof archive.put !== "function"
  ) {
    throw new ContractOwnershipConfigurationError(
      "archive bucket is not configured for contract ownership",
    );
  }
}

export class ContractOwnershipValidationError extends Error {}
export class ContractOwnershipConfigurationError extends Error {}

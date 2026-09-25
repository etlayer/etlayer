import { validateProjectId } from "./project-config.js";

export const GOVERNANCE_MANIFEST_API_VERSION =
  "etlayer.dev/v1";
export const GOVERNANCE_MANIFEST_KIND =
  "ProjectGovernance";
export const GOVERNANCE_MANIFEST_VERSION = 1;

const COMPATIBILITY_MODES = new Set([
  "backward",
  "forward",
  "full",
]);

export function normalizeGovernanceManifest(
  input = {},
) {
  if (
    input.apiVersion !==
    GOVERNANCE_MANIFEST_API_VERSION
  ) {
    throw new GovernanceManifestValidationError(
      `apiVersion must be ${GOVERNANCE_MANIFEST_API_VERSION}`,
    );
  }

  if (input.kind !== GOVERNANCE_MANIFEST_KIND) {
    throw new GovernanceManifestValidationError(
      `kind must be ${GOVERNANCE_MANIFEST_KIND}`,
    );
  }

  let projectId;
  try {
    projectId = validateProjectId(
      input.projectId,
    );
  } catch (error) {
    throw new GovernanceManifestValidationError(
      error instanceof Error
        ? error.message
        : "invalid projectId",
    );
  }

  if (
    !Array.isArray(input.contracts) ||
    input.contracts.length === 0
  ) {
    throw new GovernanceManifestValidationError(
      "contracts must contain at least one contract change",
    );
  }

  if (input.contracts.length > 25) {
    throw new GovernanceManifestValidationError(
      "contracts must contain at most 25 contract changes",
    );
  }

  const contracts = input.contracts.map(
    normalizeContractChange,
  );

  const seen = new Set();

  for (const change of contracts) {
    const key =
      change.eventName +
      "@" +
      change.currentVersion;

    if (seen.has(key)) {
      throw new GovernanceManifestValidationError(
        `duplicate contract change: ${key}`,
      );
    }

    seen.add(key);
  }

  contracts.sort((left, right) => {
    const eventName = left.eventName.localeCompare(
      right.eventName,
    );

    if (eventName !== 0) return eventName;

    return (
      left.currentVersion -
      right.currentVersion
    );
  });

  return {
    version: GOVERNANCE_MANIFEST_VERSION,
    apiVersion: GOVERNANCE_MANIFEST_API_VERSION,
    kind: GOVERNANCE_MANIFEST_KIND,
    projectId,
    contracts,
  };
}

export async function governanceManifestDigest(
  input,
  cryptoImpl = globalThis.crypto,
) {
  const normalized =
    normalizeGovernanceManifest(input);

  if (!cryptoImpl?.subtle) {
    throw new GovernanceManifestConfigurationError(
      "Web Crypto is required to digest governance manifests",
    );
  }

  const canonical =
    canonicalJson(normalized);
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );

  return Array.from(
    new Uint8Array(digest),
    (byte) =>
      byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function canonicalGovernanceManifestJson(
  input,
) {
  return canonicalJson(
    normalizeGovernanceManifest(input),
  );
}

function normalizeContractChange(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new GovernanceManifestValidationError(
      "contract change must be an object",
    );
  }

  if (
    typeof input.eventName !== "string" ||
    input.eventName.trim() === ""
  ) {
    throw new GovernanceManifestValidationError(
      "contract eventName is required",
    );
  }

  if (
    !Number.isSafeInteger(
      input.currentVersion,
    ) ||
    input.currentVersion < 1
  ) {
    throw new GovernanceManifestValidationError(
      "currentVersion must be a positive integer",
    );
  }

  const proposedContract =
    normalizeProposedContract(
      input.proposedContract,
      input.eventName,
      input.currentVersion,
    );

  const compatibilityMode =
    input.compatibilityMode || "backward";

  if (
    !COMPATIBILITY_MODES.has(
      compatibilityMode,
    )
  ) {
    throw new GovernanceManifestValidationError(
      "compatibilityMode must be backward, forward, or full",
    );
  }

  const from = parseTimestamp(
    input.from,
    "from",
  );
  const to = parseTimestamp(
    input.to,
    "to",
  );

  if (from.getTime() >= to.getTime()) {
    throw new GovernanceManifestValidationError(
      "from must be earlier than to",
    );
  }

  const maxEvents = normalizeBoundedInteger(
    input.maxEvents,
    500,
    1,
    5000,
    "maxEvents",
  );
  const maxExamples =
    normalizeBoundedInteger(
      input.maxExamples,
      25,
      0,
      100,
      "maxExamples",
    );

  return {
    eventName: input.eventName,
    currentVersion: input.currentVersion,
    compatibilityMode,
    proposedContract,
    from: from.toISOString(),
    to: to.toISOString(),
    maxEvents,
    maxExamples,
  };
}

function normalizeProposedContract(
  contract,
  eventName,
  currentVersion,
) {
  if (
    !contract ||
    typeof contract !== "object" ||
    Array.isArray(contract)
  ) {
    throw new GovernanceManifestValidationError(
      "proposedContract is required",
    );
  }

  if (contract.eventName !== eventName) {
    throw new GovernanceManifestValidationError(
      "proposedContract eventName must match eventName",
    );
  }

  if (
    !Number.isSafeInteger(contract.version) ||
    contract.version <= currentVersion
  ) {
    throw new GovernanceManifestValidationError(
      "proposedContract version must be greater than currentVersion",
    );
  }

  if (
    !contract.required ||
    typeof contract.required !== "object" ||
    Array.isArray(contract.required)
  ) {
    throw new GovernanceManifestValidationError(
      "proposedContract required must be an object",
    );
  }

  if (!Array.isArray(contract.forbidden)) {
    throw new GovernanceManifestValidationError(
      "proposedContract forbidden must be an array",
    );
  }

  const forbidden = [
    ...new Set(contract.forbidden),
  ].sort();

  if (
    forbidden.some(
      (value) =>
        typeof value !== "string" ||
        value.trim() === "",
    )
  ) {
    throw new GovernanceManifestValidationError(
      "forbidden attributes must be non-empty strings",
    );
  }

  for (const attribute of forbidden) {
    if (
      Object.hasOwn(
        contract.required,
        attribute,
      )
    ) {
      throw new GovernanceManifestValidationError(
        `attribute cannot be required and forbidden: ${attribute}`,
      );
    }
  }

  return {
    id:
      typeof contract.id === "string" &&
      contract.id.length > 0
        ? contract.id
        : `${eventName}@${contract.version}`,
    eventName,
    version: contract.version,
    required: normalizeRequired(
      contract.required,
    ),
    forbidden,
  };
}

function normalizeRequired(required) {
  const result = {};

  for (const attribute of Object.keys(
    required,
  ).sort()) {
    if (
      typeof attribute !== "string" ||
      attribute.trim() === ""
    ) {
      throw new GovernanceManifestValidationError(
        "required attribute names must be non-empty strings",
      );
    }

    const constraint = required[attribute];

    if (
      !constraint ||
      typeof constraint !== "object" ||
      Array.isArray(constraint)
    ) {
      throw new GovernanceManifestValidationError(
        `constraint must be an object: ${attribute}`,
      );
    }

    const normalized = {};

    if (
      typeof constraint.type === "string" &&
      constraint.type.length > 0
    ) {
      normalized.type = constraint.type;
    }

    if (
      Object.hasOwn(constraint, "const")
    ) {
      normalized.const = constraint.const;
    }

    result[attribute] = normalized;
  }

  return result;
}

function normalizeBoundedInteger(
  value,
  fallback,
  min,
  max,
  label,
) {
  const normalized =
    value == null ? fallback : Number(value);

  if (
    !Number.isSafeInteger(normalized) ||
    normalized < min ||
    normalized > max
  ) {
    throw new GovernanceManifestValidationError(
      `${label} must be an integer between ${min} and ${max}`,
    );
  }

  return normalized;
}

function parseTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new GovernanceManifestValidationError(
      `${label} must be an ISO timestamp`,
    );
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new GovernanceManifestValidationError(
      `${label} must be a valid ISO timestamp`,
    );
  }

  return date;
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          sortValue(value[key]),
        ]),
    );
  }

  return value;
}

export class GovernanceManifestValidationError extends Error {}
export class GovernanceManifestConfigurationError extends Error {}

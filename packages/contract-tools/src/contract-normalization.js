export function normalizeContract(
  contract,
) {
  if (
    !contract ||
    typeof contract !== "object" ||
    Array.isArray(contract)
  ) {
    throw new ContractValidationError(
      "contract must be an object",
    );
  }

  const eventName =
    normalizeEventName(
      contract.eventName,
    );
  const version =
    normalizeVersion(
      contract.version,
    );

  const required =
    contract.required;

  if (
    !required ||
    typeof required !== "object" ||
    Array.isArray(required)
  ) {
    throw new ContractValidationError(
      "contract required must be an object",
    );
  }

  if (
    !Array.isArray(
      contract.forbidden,
    )
  ) {
    throw new ContractValidationError(
      "contract forbidden must be an array",
    );
  }

  const normalizedRequired = {};

  for (
    const attribute of
    Object.keys(required).sort()
  ) {
    const constraint =
      required[attribute];

    if (
      !constraint ||
      typeof constraint !== "object" ||
      Array.isArray(constraint)
    ) {
      throw new ContractValidationError(
        `invalid constraint: ${attribute}`,
      );
    }

    const normalized = {};

    if (
      typeof constraint.type ===
        "string" &&
      constraint.type.length > 0
    ) {
      normalized.type =
        constraint.type;
    }

    if (
      Object.hasOwn(
        constraint,
        "const",
      )
    ) {
      normalized.const =
        constraint.const;
    }

    normalizedRequired[
      attribute
    ] = normalized;
  }

  const forbidden = [
    ...new Set(
      contract.forbidden,
    ),
  ].sort();

  return {
    id:
      typeof contract.id === "string" &&
      contract.id.length > 0
        ? contract.id
        : `${eventName}@${version}`,
    eventName,
    version,
    required:
      normalizedRequired,
    forbidden,
  };
}

function normalizeEventName(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new ContractValidationError(
      "eventName must be a non-empty string",
    );
  }

  return value.trim();
}

function normalizeVersion(value) {
  const version = Number(value);

  if (
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new ContractValidationError(
      "version must be a positive integer",
    );
  }

  return version;
}

export class ContractValidationError extends Error {}

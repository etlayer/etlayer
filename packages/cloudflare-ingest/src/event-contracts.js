import { findContract } from "../contracts/index.js";

export const CONTRACT_VALIDATOR_VERSION = 2;

export function validateEventContract(event, options = {}) {
  validateManagedEvent(event);

  const attributes = decodeAttributes(event.logRecord?.attributes);
  const rawVersion = attributes["etlayer.schema.version"];

  if (rawVersion == null) {
    return {
      status: "unmanaged",
      validatorVersion: CONTRACT_VALIDATOR_VERSION,
      schemaVersion: null,
      contractId: null,
      errors: [],
    };
  }

  const schemaVersion = normalizeSchemaVersion(rawVersion);

  if (schemaVersion == null) {
    return quarantined(null, null, [
      {
        code: "schema_version_invalid",
        attribute: "etlayer.schema.version",
        actual: rawVersion,
      },
    ]);
  }

  const find = options.findContract || findContract;
  const contract = find(event.eventName, schemaVersion);

  if (!contract) {
    return quarantined(schemaVersion, null, [
      {
        code: "contract_not_found",
        eventName: event.eventName,
        schemaVersion,
      },
    ]);
  }

  const contractStatus =
    normalizeContractStatus(
      options.contractStatus,
    );
  const governanceManifestDigest =
    normalizeOptionalDigest(
      options.governanceManifestDigest,
    );

  if (contractStatus === "retired") {
    return {
      ...quarantined(
        contract.version,
        contract.id || null,
        [
          {
            code: "contract_retired",
            eventName:
              event.eventName,
            schemaVersion:
              contract.version,
          },
        ],
      ),
      contractStatus,
      governanceManifestDigest,
    };
  }

  const result =
    validateEventAgainstContract(
      event,
      contract,
    );

  if (!contractStatus) {
    return result;
  }

  return {
    ...result,
    contractStatus,
    governanceManifestDigest,
  };
}

export function validateEventAgainstContract(
  event,
  contract,
) {
  validateManagedEvent(event);
  validateContract(contract, event.eventName);

  const attributes = decodeAttributes(
    event.logRecord?.attributes,
  );
  const errors = [];

  for (const [attribute, constraint] of Object.entries(
    contract.required || {},
  )) {
    if (
      !Object.hasOwn(attributes, attribute) ||
      attributes[attribute] == null
    ) {
      errors.push({
        code: "required_attribute_missing",
        attribute,
      });
      continue;
    }

    const value = attributes[attribute];

    if (
      constraint?.type &&
      !matchesPrimitiveType(value, constraint.type)
    ) {
      errors.push({
        code: "attribute_type_mismatch",
        attribute,
        expectedType: constraint.type,
        actualType: primitiveType(value),
      });
      continue;
    }

    if (
      Object.hasOwn(constraint || {}, "const") &&
      value !== constraint.const
    ) {
      errors.push({
        code: "attribute_value_mismatch",
        attribute,
        expected: constraint.const,
        actual: value,
      });
    }
  }

  for (const attribute of contract.forbidden || []) {
    if (
      Object.hasOwn(attributes, attribute) &&
      attributes[attribute] != null
    ) {
      errors.push({
        code: "forbidden_attribute_present",
        attribute,
      });
    }
  }

  if (errors.length > 0) {
    return quarantined(
      contract.version,
      contract.id || null,
      errors,
    );
  }

  return {
    status: "valid",
    validatorVersion: CONTRACT_VALIDATOR_VERSION,
    schemaVersion: contract.version,
    contractId: contract.id || null,
    errors: [],
  };
}

export function decodeEventAttributes(event) {
  return decodeAttributes(event?.logRecord?.attributes);
}

function quarantined(schemaVersion, contractId, errors) {
  return {
    status: "quarantined",
    validatorVersion: CONTRACT_VALIDATOR_VERSION,
    schemaVersion,
    contractId,
    errors,
  };
}

function normalizeContractStatus(value) {
  if (value == null) return null;

  if (
    value === "published" ||
    value === "deprecated" ||
    value === "retired"
  ) {
    return value;
  }

  throw new ContractValidationError(
    "contractStatus must be published, deprecated, or retired",
  );
}

function normalizeOptionalDigest(value) {
  if (value == null) return null;

  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{64}$/.test(value)
  ) {
    throw new ContractValidationError(
      "governanceManifestDigest must be sha256 hex",
    );
  }

  return value;
}

function normalizeSchemaVersion(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  return null;
}

function matchesPrimitiveType(value, type) {
  if (type === "integer") {
    return typeof value === "number" && Number.isSafeInteger(value);
  }

  return typeof value === type;
}

function primitiveType(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return "integer";
  }

  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function decodeAttributes(attributes) {
  if (!Array.isArray(attributes)) return {};

  return Object.fromEntries(
    attributes
      .filter((attribute) => typeof attribute?.key === "string")
      .map((attribute) => [
        attribute.key,
        decodeAnyValue(attribute.value),
      ]),
  );
}

function decodeAnyValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("bytesValue" in value) return value.bytesValue;

  if (value.arrayValue?.values) {
    return value.arrayValue.values.map(decodeAnyValue);
  }

  if (value.kvlistValue?.values) {
    return Object.fromEntries(
      value.kvlistValue.values.map((entry) => [
        entry.key,
        decodeAnyValue(entry.value),
      ]),
    );
  }

  return null;
}

function validateContract(contract, eventName) {
  if (
    !contract ||
    typeof contract !== "object" ||
    contract.eventName !== eventName ||
    !Number.isSafeInteger(contract.version) ||
    contract.version < 1
  ) {
    throw new ContractValidationError(
      "contract must match eventName and have a positive version",
    );
  }
}

function validateManagedEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new ContractValidationError("managed event must be an object");
  }

  if (typeof event.eventName !== "string" || event.eventName.trim() === "") {
    throw new ContractValidationError(
      "eventName must be a non-empty string",
    );
  }
}

export class ContractValidationError extends Error {}

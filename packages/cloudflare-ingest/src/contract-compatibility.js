export const CONTRACT_COMPATIBILITY_VERSION = 1;

const MODES = new Set([
  "backward",
  "forward",
  "full",
]);

export function analyzeContractCompatibility(
  current,
  proposed,
  options = {},
) {
  validateContract(current, "current");
  validateContract(proposed, "proposed");

  if (current.eventName !== proposed.eventName) {
    throw new ContractCompatibilityError(
      "contracts must describe the same eventName",
    );
  }

  if (proposed.version <= current.version) {
    throw new ContractCompatibilityError(
      "proposed contract version must be greater than current version",
    );
  }

  const mode = options.mode || "backward";
  if (!MODES.has(mode)) {
    throw new ContractCompatibilityError(
      "compatibility mode must be backward, forward, or full",
    );
  }

  const backward = directionalCompatibility(
    current,
    proposed,
    "backward",
  );
  const forward = directionalCompatibility(
    proposed,
    current,
    "forward",
  );
  const changes = structuralChanges(
    current,
    proposed,
    backward,
    forward,
  );

  const compatible =
    mode === "backward"
      ? backward.compatible
      : mode === "forward"
        ? forward.compatible
        : backward.compatible &&
          forward.compatible;

  return {
    version: CONTRACT_COMPATIBILITY_VERSION,
    eventName: current.eventName,
    fromVersion: current.version,
    toVersion: proposed.version,
    mode,
    compatible,
    classification:
      compatible ? "compatible" : "breaking",
    backward,
    forward,
    changes,
  };
}

function directionalCompatibility(
  source,
  target,
  direction,
) {
  const violations = [];
  const sourceRequired = source.required || {};
  const targetRequired = target.required || {};
  const sourceForbidden = new Set(
    source.forbidden || [],
  );
  const targetForbidden = new Set(
    target.forbidden || [],
  );

  for (const attribute of Object.keys(targetRequired)) {
    if (!Object.hasOwn(sourceRequired, attribute)) {
      violations.push({
        code:
          direction === "backward"
            ? "required_attribute_added"
            : "required_attribute_removed",
        attribute,
      });
    }
  }

  for (const attribute of targetForbidden) {
    if (!sourceForbidden.has(attribute)) {
      violations.push({
        code:
          direction === "backward"
            ? "attribute_newly_forbidden"
            : "attribute_no_longer_forbidden",
        attribute,
      });
    }
  }

  for (const [attribute, sourceConstraint] of Object.entries(
    sourceRequired,
  )) {
    if (!Object.hasOwn(targetRequired, attribute)) {
      continue;
    }

    const targetConstraint =
      targetRequired[attribute];

    if (
      !constraintSetIsSubset(
        sourceConstraint || {},
        targetConstraint || {},
      )
    ) {
      violations.push({
        code:
          direction === "backward"
            ? "attribute_constraint_narrowed"
            : "attribute_constraint_relaxed",
        attribute,
        source: normalizedConstraint(
          sourceConstraint,
        ),
        target: normalizedConstraint(
          targetConstraint,
        ),
      });
    }
  }

  return {
    compatible: violations.length === 0,
    violations,
  };
}

function structuralChanges(
  current,
  proposed,
  backward,
  forward,
) {
  const attributes = new Set([
    ...Object.keys(current.required || {}),
    ...Object.keys(proposed.required || {}),
    ...(current.forbidden || []),
    ...(proposed.forbidden || []),
  ]);
  const backwardByAttribute =
    violationsByAttribute(backward.violations);
  const forwardByAttribute =
    violationsByAttribute(forward.violations);

  const changes = [];

  for (const attribute of [...attributes].sort()) {
    const before = attributeState(current, attribute);
    const after = attributeState(proposed, attribute);

    if (
      JSON.stringify(before) ===
      JSON.stringify(after)
    ) {
      continue;
    }

    changes.push({
      attribute,
      before,
      after,
      backwardBreaking:
        backwardByAttribute.has(attribute),
      forwardBreaking:
        forwardByAttribute.has(attribute),
    });
  }

  return changes;
}

function attributeState(contract, attribute) {
  if (
    (contract.forbidden || []).includes(attribute)
  ) {
    return {
      presence: "forbidden",
      constraint: null,
    };
  }

  if (
    Object.hasOwn(
      contract.required || {},
      attribute,
    )
  ) {
    return {
      presence: "required",
      constraint: normalizedConstraint(
        contract.required[attribute],
      ),
    };
  }

  return {
    presence: "optional",
    constraint: null,
  };
}

function violationsByAttribute(violations) {
  return new Set(
    violations
      .map(({ attribute }) => attribute)
      .filter(Boolean),
  );
}

function constraintSetIsSubset(source, target) {
  const sourceConstraint =
    normalizedConstraint(source);
  const targetConstraint =
    normalizedConstraint(target);

  if (
    Object.hasOwn(sourceConstraint, "const")
  ) {
    return constraintAccepts(
      targetConstraint,
      sourceConstraint.const,
    );
  }

  if (
    Object.hasOwn(targetConstraint, "const")
  ) {
    return false;
  }

  return typeSetIsSubset(
    sourceConstraint.type || null,
    targetConstraint.type || null,
  );
}

function constraintAccepts(constraint, value) {
  if (
    Object.hasOwn(constraint, "const") &&
    constraint.const !== value
  ) {
    return false;
  }

  if (!constraint.type) return value != null;

  return matchesType(value, constraint.type);
}

function typeSetIsSubset(sourceType, targetType) {
  if (targetType == null) return true;
  if (sourceType == null) return false;
  if (sourceType === targetType) return true;

  return (
    sourceType === "integer" &&
    targetType === "number"
  );
}

function matchesType(value, type) {
  if (value == null) return false;

  if (type === "integer") {
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value)
    );
  }

  if (type === "number") {
    return typeof value === "number";
  }

  return typeof value === type;
}

function normalizedConstraint(value = {}) {
  const result = {};

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    if (
      typeof value.type === "string" &&
      value.type.length > 0
    ) {
      result.type = value.type;
    }

    if (Object.hasOwn(value, "const")) {
      result.const = value.const;
    }
  }

  return result;
}

function validateContract(contract, label) {
  if (
    !contract ||
    typeof contract !== "object" ||
    Array.isArray(contract)
  ) {
    throw new ContractCompatibilityError(
      `${label} contract must be an object`,
    );
  }

  if (
    typeof contract.eventName !== "string" ||
    contract.eventName.trim() === ""
  ) {
    throw new ContractCompatibilityError(
      `${label} eventName must be a non-empty string`,
    );
  }

  if (
    !Number.isSafeInteger(contract.version) ||
    contract.version < 1
  ) {
    throw new ContractCompatibilityError(
      `${label} version must be a positive integer`,
    );
  }

  if (
    contract.required == null ||
    typeof contract.required !== "object" ||
    Array.isArray(contract.required)
  ) {
    throw new ContractCompatibilityError(
      `${label} required must be an object`,
    );
  }

  if (!Array.isArray(contract.forbidden)) {
    throw new ContractCompatibilityError(
      `${label} forbidden must be an array`,
    );
  }

  const forbidden = new Set();

  for (const attribute of contract.forbidden) {
    validateAttribute(attribute, label);

    if (forbidden.has(attribute)) {
      throw new ContractCompatibilityError(
        `${label} forbidden attributes must be unique`,
      );
    }

    forbidden.add(attribute);
  }

  for (const [attribute, constraint] of Object.entries(
    contract.required,
  )) {
    validateAttribute(attribute, label);

    if (forbidden.has(attribute)) {
      throw new ContractCompatibilityError(
        `${label} attribute cannot be both required and forbidden: ${attribute}`,
      );
    }

    if (
      !constraint ||
      typeof constraint !== "object" ||
      Array.isArray(constraint)
    ) {
      throw new ContractCompatibilityError(
        `${label} constraint must be an object: ${attribute}`,
      );
    }

    const normalized =
      normalizedConstraint(constraint);

    if (
      Object.hasOwn(normalized, "const") &&
      normalized.type &&
      !matchesType(
        normalized.const,
        normalized.type,
      )
    ) {
      throw new ContractCompatibilityError(
        `${label} const does not match type: ${attribute}`,
      );
    }
  }
}

function validateAttribute(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new ContractCompatibilityError(
      `${label} attribute names must be non-empty strings`,
    );
  }
}

export class ContractCompatibilityError extends Error {}

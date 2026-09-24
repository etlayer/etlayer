import { evaluateEventAuthority } from "./authority.js";
import {
  analyzeContractCompatibility,
  ContractCompatibilityError,
} from "./contract-compatibility.js";
import {
  decodeEventAttributes,
  validateEventAgainstContract,
} from "./event-contracts.js";
import { resolveDecisionOutcome } from "./decision-history.js";
import { findContract } from "../contracts/index.js";
import {
  ReplayArchiveError,
  ReplayConfigurationError,
  ReplayLimitError,
  ReplayValidationError,
  selectArchivedEvents,
} from "./replay.js";

export const CONTRACT_PLAN_VERSION = 1;
const DEFAULT_MAX_EXAMPLES = 25;
const HARD_MAX_EXAMPLES = 100;

export async function planContractChange(
  env,
  input,
  options = {},
) {
  if (
    !env?.ARCHIVE ||
    typeof env.ARCHIVE.list !== "function" ||
    typeof env.ARCHIVE.get !== "function"
  ) {
    throw new ContractPlanConfigurationError(
      "archive bucket is not configured for contract planning",
    );
  }

  const normalized = normalizeInput(input);
  const find = options.findContract || findContract;
  const current = find(
    normalized.eventName,
    normalized.currentVersion,
  );

  if (!current) {
    throw new ContractPlanValidationError(
      "current contract was not found",
    );
  }

  let compatibility;
  try {
    compatibility = analyzeContractCompatibility(
      current,
      normalized.proposedContract,
      { mode: normalized.compatibilityMode },
    );
  } catch (error) {
    if (error instanceof ContractCompatibilityError) {
      throw new ContractPlanValidationError(error.message);
    }
    throw error;
  }

  const selected = await selectArchivedEvents(
    env.ARCHIVE,
    {
      projectId: normalized.projectId,
      from: normalized.from,
      to: normalized.to,
      maxEvents: normalized.maxEvents,
    },
    {
      listPageSize: options.listPageSize,
      filterEvent(event) {
        if (event.eventName !== normalized.eventName) {
          return false;
        }

        const attributes = decodeEventAttributes(event);
        return (
          attributes["etlayer.schema.version"] ===
          normalized.currentVersion
        );
      },
    },
  );

  const transitions = {};
  const examples = [];
  let changed = 0;

  for (const item of selected) {
    const currentValidation =
      validateEventAgainstContract(
        item.event,
        current,
      );
    const proposedValidation =
      validateEventAgainstContract(
        item.event,
        normalized.proposedContract,
      );
    const authority = evaluateEventAuthority(
      item.event,
    );

    const before = resolveDecisionOutcome(
      currentValidation,
      authority,
    );
    const after = resolveDecisionOutcome(
      proposedValidation,
      authority,
    );
    const transition = before + "_to_" + after;
    transitions[transition] =
      (transitions[transition] || 0) + 1;

    if (before !== after) {
      changed += 1;

      if (
        examples.length <
        normalized.maxExamples
      ) {
        examples.push({
          eventId: item.event.id,
          sourceKey: item.key,
          before,
          after,
          currentValidation: summarizeValidation(
            currentValidation,
          ),
          proposedValidation: summarizeValidation(
            proposedValidation,
          ),
          authority: {
            status: authority.status,
            errors: authority.errors || [],
          },
        });
      }
    }
  }

  return {
    version: CONTRACT_PLAN_VERSION,
    projectId: normalized.projectId,
    eventName: normalized.eventName,
    currentVersion: normalized.currentVersion,
    proposedVersion:
      normalized.proposedContract.version,
    from: new Date(normalized.from).toISOString(),
    to: new Date(normalized.to).toISOString(),
    selected: selected.length,
    changed,
    transitions,
    compatibility,
    examples,
  };
}

function summarizeValidation(validation) {
  return {
    status: validation.status,
    schemaVersion: validation.schemaVersion,
    contractId: validation.contractId,
    errors: validation.errors || [],
  };
}

function normalizeInput(input = {}) {
  if (
    typeof input.projectId !== "string" ||
    input.projectId.trim() === ""
  ) {
    throw new ContractPlanValidationError(
      "projectId is required",
    );
  }

  if (
    typeof input.eventName !== "string" ||
    input.eventName.trim() === ""
  ) {
    throw new ContractPlanValidationError(
      "eventName is required",
    );
  }

  if (
    !Number.isSafeInteger(input.currentVersion) ||
    input.currentVersion < 1
  ) {
    throw new ContractPlanValidationError(
      "currentVersion must be a positive integer",
    );
  }

  if (
    !input.proposedContract ||
    typeof input.proposedContract !== "object"
  ) {
    throw new ContractPlanValidationError(
      "proposedContract is required",
    );
  }

  if (
    input.proposedContract.eventName !==
    input.eventName
  ) {
    throw new ContractPlanValidationError(
      "proposedContract eventName must match eventName",
    );
  }

  const from = parseDate(input.from, "from");
  const to = parseDate(input.to, "to");
  if (from.getTime() >= to.getTime()) {
    throw new ContractPlanValidationError(
      "from must be earlier than to",
    );
  }

  const maxEvents =
    input.maxEvents == null
      ? 500
      : Number(input.maxEvents);
  if (
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1 ||
    maxEvents > 5000
  ) {
    throw new ContractPlanValidationError(
      "maxEvents must be an integer between 1 and 5000",
    );
  }

  const maxExamples =
    input.maxExamples == null
      ? DEFAULT_MAX_EXAMPLES
      : Number(input.maxExamples);
  if (
    !Number.isSafeInteger(maxExamples) ||
    maxExamples < 0 ||
    maxExamples > HARD_MAX_EXAMPLES
  ) {
    throw new ContractPlanValidationError(
      "maxExamples must be an integer between 0 and 100",
    );
  }

  const compatibilityMode =
    input.compatibilityMode || "backward";

  return {
    projectId: input.projectId,
    eventName: input.eventName,
    currentVersion: input.currentVersion,
    proposedContract: input.proposedContract,
    from: from.toISOString(),
    to: to.toISOString(),
    maxEvents,
    maxExamples,
    compatibilityMode,
  };
}

function parseDate(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new ContractPlanValidationError(
      `${label} must be an ISO timestamp`,
    );
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ContractPlanValidationError(
      `${label} must be a valid ISO timestamp`,
    );
  }

  return date;
}

export {
  ReplayArchiveError,
  ReplayConfigurationError,
  ReplayLimitError,
  ReplayValidationError,
};

export class ContractPlanValidationError extends Error {}
export class ContractPlanConfigurationError extends Error {}

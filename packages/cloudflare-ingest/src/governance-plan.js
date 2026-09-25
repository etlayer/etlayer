import {
  analyzeContractCompatibility,
  ContractCompatibilityError,
} from "./contract-compatibility.js";
import {
  ContractPlanConfigurationError,
  ContractPlanValidationError,
  ReplayArchiveError,
  ReplayConfigurationError,
  ReplayLimitError,
  ReplayValidationError,
  planContractChange,
} from "./contract-plan.js";
import {
  GovernanceManifestConfigurationError,
  GovernanceManifestValidationError,
  governanceManifestDigest,
  normalizeGovernanceManifest,
} from "./governance-manifest.js";
import { findContract } from "../contracts/index.js";

export const GOVERNANCE_PLAN_VERSION = 1;

export async function checkGovernanceManifest(
  manifest,
  options = {},
) {
  const normalized =
    normalizeGovernanceManifest(manifest);
  const digest =
    await governanceManifestDigest(
      normalized,
      options.crypto,
    );
  const find =
    options.findContract || findContract;

  const contracts = normalized.contracts.map(
    (change) => {
      const current = find(
        change.eventName,
        change.currentVersion,
      );

      if (!current) {
        throw new GovernancePlanValidationError(
          `current contract was not found: ${change.eventName}@${change.currentVersion}`,
        );
      }

      let compatibility;

      try {
        compatibility =
          analyzeContractCompatibility(
            current,
            change.proposedContract,
            {
              mode:
                change.compatibilityMode,
            },
          );
      } catch (error) {
        if (
          error instanceof
            ContractCompatibilityError
        ) {
          throw new GovernancePlanValidationError(
            error.message,
          );
        }

        throw error;
      }

      return {
        eventName: change.eventName,
        currentVersion:
          change.currentVersion,
        proposedVersion:
          change.proposedContract.version,
        compatibilityMode:
          change.compatibilityMode,
        compatibility,
      };
    },
  );

  return {
    version: GOVERNANCE_PLAN_VERSION,
    manifestDigest: digest,
    manifest: normalized,
    compatible: contracts.every(
      (item) =>
        item.compatibility.compatible,
    ),
    contracts,
  };
}

export async function planGovernanceManifest(
  env,
  manifest,
  options = {},
) {
  if (
    !env?.ARCHIVE ||
    typeof env.ARCHIVE.list !== "function" ||
    typeof env.ARCHIVE.get !== "function"
  ) {
    throw new GovernancePlanConfigurationError(
      "archive bucket is not configured for governance planning",
    );
  }

  const checked =
    await checkGovernanceManifest(
      manifest,
      options,
    );
  const planContract =
    options.planContractChange ||
    planContractChange;
  const plans = [];

  for (
    const change of
    checked.manifest.contracts
  ) {
    try {
      plans.push(
        await planContract(
          env,
          {
            projectId:
              checked.manifest.projectId,
            eventName: change.eventName,
            currentVersion:
              change.currentVersion,
            proposedContract:
              change.proposedContract,
            from: change.from,
            to: change.to,
            maxEvents: change.maxEvents,
            maxExamples:
              change.maxExamples,
            compatibilityMode:
              change.compatibilityMode,
          },
          options,
        ),
      );
    } catch (error) {
      if (
        error instanceof
          ContractPlanValidationError ||
        error instanceof
          ReplayValidationError ||
        error instanceof ReplayLimitError
      ) {
        throw new GovernancePlanValidationError(
          error.message,
        );
      }

      if (
        error instanceof
          ContractPlanConfigurationError ||
        error instanceof
          ReplayConfigurationError
      ) {
        throw new GovernancePlanConfigurationError(
          error.message,
        );
      }

      if (
        error instanceof ReplayArchiveError
      ) {
        throw new GovernancePlanArchiveError(
          error.message,
        );
      }

      throw error;
    }
  }

  const selected = plans.reduce(
    (total, plan) =>
      total + (plan.selected || 0),
    0,
  );
  const changed = plans.reduce(
    (total, plan) =>
      total + (plan.changed || 0),
    0,
  );

  return {
    version: GOVERNANCE_PLAN_VERSION,
    manifestDigest:
      checked.manifestDigest,
    projectId:
      checked.manifest.projectId,
    compatible: checked.compatible,
    selected,
    changed,
    contracts: plans.map((plan) => ({
      eventName: plan.eventName,
      currentVersion:
        plan.currentVersion,
      proposedVersion:
        plan.proposedVersion,
      selected: plan.selected,
      changed: plan.changed,
      transitions: plan.transitions,
      compatibility:
        plan.compatibility,
      examples: plan.examples,
    })),
  };
}

export {
  GovernanceManifestConfigurationError,
  GovernanceManifestValidationError,
};

export class GovernancePlanValidationError extends Error {}
export class GovernancePlanConfigurationError extends Error {}
export class GovernancePlanArchiveError extends Error {}

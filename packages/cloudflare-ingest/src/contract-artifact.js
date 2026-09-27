import {
  findContract,
} from "../contracts/index.js";
import {
  ContractValidationError,
  normalizeContract as normalizeSharedContract,
} from "../../contract-tools/src/contract-normalization.js";
import {
  readPublishedContract,
} from "./governance-publication.js";

export const CONTRACT_ARTIFACT_VERSION = 1;

export async function buildContractArtifact(
  env,
  input,
) {
  if (
    !env?.ARCHIVE ||
    typeof env.ARCHIVE.get !== "function"
  ) {
    throw new ContractArtifactConfigurationError(
      "archive bucket is not configured for contract artifacts",
    );
  }

  const projectId =
    normalizeProjectId(
      input?.projectId,
    );
  const eventName =
    normalizeEventName(
      input?.eventName,
    );
  const version =
    normalizeVersion(
      input?.version,
    );

  const published =
    await readPublishedContract(
      env.ARCHIVE,
      projectId,
      eventName,
      version,
    );

  if (published?.contract) {
    return artifactResponse({
      projectId,
      source: "project",
      contract:
        published.contract,
      lifecycle: {
        status:
          published.contractStatus,
        manifestDigest:
          published.manifestDigest,
        publishedAt:
          published.publishedAt,
      },
      requestUrl:
        input?.requestUrl,
    });
  }

  const builtin =
    findContract(
      eventName,
      version,
    );

  if (!builtin) {
    throw new ContractArtifactNotFoundError(
      "contract was not found",
    );
  }

  return artifactResponse({
    projectId,
    source: "builtin",
    contract: builtin,
    lifecycle: null,
    requestUrl:
      input?.requestUrl,
  });
}

function artifactResponse({
  projectId,
  source,
  contract,
  lifecycle,
  requestUrl,
}) {
  const normalized =
    normalizeContract(contract);
  const links =
    buildLinks(
      requestUrl,
      projectId,
      normalized.eventName,
      normalized.version,
    );

  return {
    version:
      CONTRACT_ARTIFACT_VERSION,
    apiVersion: "v1",
    kind: "Contract",
    projectId,
    source,
    contract: normalized,
    lifecycle,
    links,
  };
}

export function normalizeContract(
  contract,
) {
  try {
    return normalizeSharedContract(
      contract,
    );
  } catch (error) {
    if (
      error instanceof
      ContractValidationError
    ) {
      throw new ContractArtifactValidationError(
        error.message,
      );
    }

    throw error;
  }
}

function buildLinks(
  requestUrl,
  projectId,
  eventName,
  version,
) {
  let url;

  try {
    url = new URL(requestUrl);
  } catch {
    throw new ContractArtifactValidationError(
      "requestUrl must be a valid URL",
    );
  }

  const project =
    encodeURIComponent(projectId);
  const event =
    encodeURIComponent(eventName);

  return {
    self:
      `${url.origin}/api/v1/projects/${project}/contracts/${event}/${version}`,
    project:
      `${url.origin}/api/v1/projects/${project}`,
  };
}

function normalizeProjectId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(
      value,
    )
  ) {
    throw new ContractArtifactValidationError(
      "projectId must be a lowercase slug",
    );
  }

  return value;
}

function normalizeEventName(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new ContractArtifactValidationError(
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
    throw new ContractArtifactValidationError(
      "version must be a positive integer",
    );
  }

  return version;
}

export class ContractArtifactValidationError extends Error {}
export class ContractArtifactNotFoundError extends Error {}
export class ContractArtifactConfigurationError extends Error {}

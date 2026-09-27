import {
  listContracts,
} from "../contracts/index.js";
import {
  readPublishedContract,
} from "./governance-publication.js";
import {
  validateProjectId,
} from "./project-config.js";

export const CONTRACT_CATALOG_VERSION = 1;

const LIST_PAGE_SIZE = 1000;
const MAX_PROJECT_CONTRACTS = 5000;

export async function buildContractCatalog(
  env,
  input,
  options = {},
) {
  if (
    !env?.ARCHIVE ||
    typeof env.ARCHIVE.get !== "function" ||
    typeof env.ARCHIVE.list !== "function"
  ) {
    throw new ContractCatalogConfigurationError(
      "archive bucket is not configured for contract catalog",
    );
  }

  const projectId =
    normalizeProjectId(
      input?.projectId,
    );
  const requestUrl =
    normalizeRequestUrl(
      input?.requestUrl,
    );

  const effective = new Map();

  for (const contract of listContracts()) {
    const item = catalogItem({
      projectId,
      requestUrl,
      eventName:
        contract.eventName,
      version:
        contract.version,
      source: "builtin",
      lifecycle: null,
    });

    effective.set(
      contractKey(
        item.eventName,
        item.version,
      ),
      item,
    );
  }

  const projectCoordinates =
    await listProjectContractCoordinates(
      env.ARCHIVE,
      projectId,
      options,
    );

  for (const coordinate of projectCoordinates) {
    const published =
      await readPublishedContract(
        env.ARCHIVE,
        projectId,
        coordinate.eventName,
        coordinate.version,
      );

    if (!published?.contract) {
      continue;
    }

    const item = catalogItem({
      projectId,
      requestUrl,
      eventName:
        coordinate.eventName,
      version:
        coordinate.version,
      source: "project",
      lifecycle:
        published.contractStatus,
    });

    effective.set(
      contractKey(
        item.eventName,
        item.version,
      ),
      item,
    );
  }

  const contracts = [
    ...effective.values(),
  ].sort(compareCatalogItems);

  return {
    version:
      CONTRACT_CATALOG_VERSION,
    apiVersion: "v1",
    kind: "ContractCatalog",
    projectId,
    contracts,
    links:
      catalogLinks(
        requestUrl,
        projectId,
      ),
  };
}

async function listProjectContractCoordinates(
  archive,
  projectId,
  options,
) {
  const prefix =
    projectContractsPrefix(
      projectId,
    );
  const keys = [];
  let cursor;

  do {
    const page =
      await archive.list({
        prefix,
        cursor,
        limit:
          options.listPageSize ||
          LIST_PAGE_SIZE,
      });

    for (const object of page.objects || []) {
      keys.push(object.key);

      if (
        keys.length >
        MAX_PROJECT_CONTRACTS
      ) {
        throw new ContractCatalogConfigurationError(
          `project contract catalog exceeds ${MAX_PROJECT_CONTRACTS} resources`,
        );
      }
    }

    cursor =
      page.truncated &&
      page.cursor
        ? page.cursor
        : undefined;
  } while (cursor);

  const coordinates = [];

  for (const key of keys.sort()) {
    const relative =
      key.slice(prefix.length);
    const match =
      relative.match(
        /^([^/]+)\/(\d+)\.json$/,
      );

    if (!match) {
      continue;
    }

    let eventName;

    try {
      eventName =
        decodeURIComponent(match[1]);
    } catch {
      throw new ContractCatalogConfigurationError(
        `project contract key is invalid: ${key}`,
      );
    }

    const version =
      Number(match[2]);

    if (
      !Number.isSafeInteger(
        version,
      ) ||
      version < 1
    ) {
      continue;
    }

    coordinates.push({
      eventName,
      version,
    });
  }

  return coordinates;
}

function catalogItem({
  projectId,
  requestUrl,
  eventName,
  version,
  source,
  lifecycle,
}) {
  return {
    eventName,
    version,
    source,
    lifecycle,
    links: {
      self:
        exactContractUrl(
          requestUrl,
          projectId,
          eventName,
          version,
        ),
    },
  };
}

function catalogLinks(
  requestUrl,
  projectId,
) {
  const project =
    encodeURIComponent(projectId);

  return {
    self:
      `${requestUrl.origin}/api/v1/projects/${project}/contracts`,
    project:
      `${requestUrl.origin}/api/v1/projects/${project}`,
  };
}

function exactContractUrl(
  requestUrl,
  projectId,
  eventName,
  version,
) {
  const project =
    encodeURIComponent(projectId);
  const event =
    encodeURIComponent(eventName);

  return (
    `${requestUrl.origin}/api/v1/projects/${project}` +
    `/contracts/${event}/${version}`
  );
}

function projectContractsPrefix(
  projectId,
) {
  return (
    "registry/governance/" +
    encodeURIComponent(projectId) +
    "/contracts/"
  );
}

function compareCatalogItems(
  left,
  right,
) {
  const event =
    left.eventName.localeCompare(
      right.eventName,
    );

  if (event !== 0) {
    return event;
  }

  return left.version - right.version;
}

function contractKey(
  eventName,
  version,
) {
  return `${eventName}@${version}`;
}

function normalizeProjectId(value) {
  try {
    return validateProjectId(value);
  } catch {
    throw new ContractCatalogValidationError(
      "projectId must be a valid lowercase slug",
    );
  }
}

function normalizeRequestUrl(value) {
  try {
    return new URL(value);
  } catch {
    throw new ContractCatalogValidationError(
      "requestUrl must be a valid URL",
    );
  }
}

export class ContractCatalogValidationError extends Error {}
export class ContractCatalogConfigurationError extends Error {}

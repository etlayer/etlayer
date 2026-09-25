import {
  decodeEventAttributes,
} from "./event-contracts.js";
import {
  governanceManifestDigest,
  normalizeGovernanceManifest,
} from "./governance-manifest.js";
import {
  projectIdForEvent,
} from "./project-scope.js";

export const GOVERNANCE_PUBLICATION_VERSION = 1;

export async function publishGovernanceManifest(
  archive,
  input,
  options = {},
) {
  requireArchive(archive);

  const manifest =
    normalizeGovernanceManifest(
      input?.manifest,
    );
  const manifestDigest =
    await governanceManifestDigest(
      manifest,
      options.crypto,
    );

  if (
    input?.manifestDigest !==
    manifestDigest
  ) {
    throw new GovernancePublicationDigestMismatchError(
      "manifestDigest does not match normalized governance manifest",
    );
  }

  const plan = input?.plan;

  if (
    !plan ||
    plan.manifestDigest !==
      manifestDigest ||
    plan.projectId !== manifest.projectId
  ) {
    throw new GovernancePublicationValidationError(
      "governance publication requires the matching current plan",
    );
  }

  if (
    plan.compatible === false &&
    input?.acknowledgeBreaking !== true
  ) {
    throw new GovernancePublicationBreakingChangeError(
      "breaking governance publication requires acknowledgeBreaking=true",
    );
  }

  const now = normalizeDate(
    options.now,
    "publishedAt",
  );
  const publishedAt = now.toISOString();
  const contractRecords = [];

  for (const change of manifest.contracts) {
    const record = {
      version: GOVERNANCE_PUBLICATION_VERSION,
      projectId: manifest.projectId,
      manifestDigest,
      publishedAt,
      contract: change.proposedContract,
    };
    const key = governanceContractKey(
      manifest.projectId,
      change.eventName,
      change.proposedContract.version,
    );

    const existing =
      await readJson(archive, key);

    if (existing) {
      assertSameContractRecord(
        existing,
        record,
        key,
      );
      contractRecords.push({
        key,
        record: existing,
        created: false,
      });
      continue;
    }

    const stored = await putCreateOnly(
      archive,
      key,
      record,
      {
        kind: "governance_contract",
        project_id:
          manifest.projectId,
        event_name:
          change.eventName,
        contract_version: String(
          change.proposedContract.version,
        ),
        manifest_digest:
          manifestDigest,
      },
    );

    if (!stored) {
      const raced =
        await readJson(archive, key);

      if (!raced) {
        throw new GovernancePublicationConfigurationError(
          `published contract could not be read after create race: ${key}`,
        );
      }

      assertSameContractRecord(
        raced,
        record,
        key,
      );
      contractRecords.push({
        key,
        record: raced,
        created: false,
      });
      continue;
    }

    contractRecords.push({
      key,
      record,
      created: true,
    });
  }

  const publicationKey =
    governancePublicationKey(
      manifest.projectId,
      manifestDigest,
    );
  const existingPublication =
    await readJson(
      archive,
      publicationKey,
    );

  if (existingPublication) {
    assertSamePublication(
      existingPublication,
      manifest,
      manifestDigest,
      publicationKey,
    );

    return {
      created: false,
      key: publicationKey,
      publication:
        existingPublication,
      contracts: contractRecords,
    };
  }

  const publication = {
    version:
      GOVERNANCE_PUBLICATION_VERSION,
    projectId: manifest.projectId,
    manifestDigest,
    publishedAt,
    compatible:
      plan.compatible === true,
    selected:
      Number(plan.selected || 0),
    changed:
      Number(plan.changed || 0),
    manifest,
  };

  const publicationStored =
    await putCreateOnly(
      archive,
      publicationKey,
      publication,
      {
        kind:
          "governance_publication",
        project_id:
          manifest.projectId,
        manifest_digest:
          manifestDigest,
        compatible:
          String(publication.compatible),
        selected: String(
          publication.selected,
        ),
        changed: String(
          publication.changed,
        ),
      },
    );

  if (!publicationStored) {
    const raced =
      await readJson(
        archive,
        publicationKey,
      );

    if (!raced) {
      throw new GovernancePublicationConfigurationError(
        `governance publication could not be read after create race: ${publicationKey}`,
      );
    }

    assertSamePublication(
      raced,
      manifest,
      manifestDigest,
      publicationKey,
    );

    return {
      created: false,
      key: publicationKey,
      publication: raced,
      contracts: contractRecords,
    };
  }

  return {
    created: true,
    key: publicationKey,
    publication,
    contracts: contractRecords,
  };
}

export async function readGovernancePublication(
  archive,
  projectId,
  manifestDigest,
) {
  return readJson(
    archive,
    governancePublicationKey(
      projectId,
      manifestDigest,
    ),
  );
}

export async function readPublishedContract(
  archive,
  projectId,
  eventName,
  version,
) {
  const record = await readJson(
    archive,
    governanceContractKey(
      projectId,
      eventName,
      version,
    ),
  );

  if (!record) return null;

  if (
    record.version !==
      GOVERNANCE_PUBLICATION_VERSION ||
    record.projectId !== projectId ||
    record.contract?.eventName !==
      eventName ||
    record.contract?.version !==
      version ||
    !isDigest(
      record.manifestDigest,
    )
  ) {
    throw new GovernancePublicationConfigurationError(
      `published governance contract is invalid: ${governanceContractKey(
        projectId,
        eventName,
        version,
      )}`,
    );
  }

  return {
    contract: record.contract,
    manifestDigest:
      record.manifestDigest,
    publishedAt:
      record.publishedAt,
  };
}

export async function resolvePublishedContractForEvent(
  archive,
  event,
) {
  if (
    !archive ||
    typeof archive.get !== "function"
  ) {
    return null;
  }

  const attributes =
    decodeEventAttributes(event);
  const version =
    attributes[
      "etlayer.schema.version"
    ];

  if (
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return null;
  }

  const projectId =
    projectIdForEvent(event);

  return readPublishedContract(
    archive,
    projectId,
    event.eventName,
    version,
  );
}

export function governanceContractKey(
  projectId,
  eventName,
  version,
) {
  validateProjectId(projectId);
  validateEventName(eventName);

  if (
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new GovernancePublicationValidationError(
      "contract version must be a positive integer",
    );
  }

  return (
    "registry/governance/" +
    encodeURIComponent(projectId) +
    "/contracts/" +
    encodeURIComponent(eventName) +
    "/" +
    String(version) +
    ".json"
  );
}

export function governancePublicationKey(
  projectId,
  manifestDigest,
) {
  validateProjectId(projectId);

  if (!isDigest(manifestDigest)) {
    throw new GovernancePublicationValidationError(
      "manifestDigest must be sha256 hex",
    );
  }

  return (
    "registry/governance/" +
    encodeURIComponent(projectId) +
    "/publications/" +
    manifestDigest +
    ".json"
  );
}

function assertSameContractRecord(
  existing,
  expected,
  key,
) {
  if (
    existing.projectId !==
      expected.projectId ||
    existing.manifestDigest !==
      expected.manifestDigest ||
    canonicalJson(existing.contract) !==
      canonicalJson(expected.contract)
  ) {
    throw new GovernancePublicationConflictError(
      `published contract already exists with different content: ${key}`,
    );
  }
}

function assertSamePublication(
  existing,
  manifest,
  manifestDigest,
  key,
) {
  if (
    existing.projectId !==
      manifest.projectId ||
    existing.manifestDigest !==
      manifestDigest ||
    canonicalJson(existing.manifest) !==
      canonicalJson(manifest)
  ) {
    throw new GovernancePublicationConflictError(
      `governance publication already exists with different content: ${key}`,
    );
  }
}

async function readJson(
  archive,
  key,
) {
  if (
    !archive ||
    typeof archive.get !== "function"
  ) {
    return null;
  }

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
    throw new GovernancePublicationConfigurationError(
      `governance object has no readable body: ${key}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new GovernancePublicationConfigurationError(
      `governance object is not valid JSON: ${key}`,
    );
  }
}

async function putCreateOnly(
  archive,
  key,
  value,
  customMetadata,
) {
  const stored =
    await archive.put(
      key,
      JSON.stringify(value),
      {
        onlyIf: {
          etagDoesNotMatch: "*",
        },
        httpMetadata: {
          contentType:
            "application/json; charset=utf-8",
        },
        customMetadata,
      },
    );

  return stored !== null;
}

function requireArchive(archive) {
  if (
    !archive ||
    typeof archive.get !== "function" ||
    typeof archive.put !== "function"
  ) {
    throw new GovernancePublicationConfigurationError(
      "archive bucket is not configured for governance publication",
    );
  }
}

function validateProjectId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(
      value,
    )
  ) {
    throw new GovernancePublicationValidationError(
      "projectId must be a lowercase slug",
    );
  }
}

function validateEventName(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new GovernancePublicationValidationError(
      "eventName must be a non-empty string",
    );
  }
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
    throw new GovernancePublicationValidationError(
      `${label} is invalid`,
    );
  }

  return date;
}

function isDigest(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{64}$/.test(value)
  );
}

function canonicalJson(value) {
  return JSON.stringify(
    sortValue(value),
  );
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

export class GovernancePublicationValidationError extends Error {}
export class GovernancePublicationDigestMismatchError extends Error {}
export class GovernancePublicationBreakingChangeError extends Error {}
export class GovernancePublicationConflictError extends Error {}
export class GovernancePublicationConfigurationError extends Error {}

import {
  ENCRYPTION_ROOT_VERSIONS,
} from "./encryption-roots.js";

const DESTINATION_PREFIX =
  "registry/destination-credentials/";
const IDEMPOTENCY_PREFIX =
  "registry/idempotency/";

export async function auditEncryptionKeyUsage(
  archive,
  {
    now = new Date(),
  } = {},
) {
  requireListableArchive(archive);
  const timestamp = normalizeDate(now);

  const destinationCounts = versionCounts();
  const idempotencyCounts = versionCounts();
  const unknown = {
    destination: {},
    idempotency: {},
  };

  const destinationKeys = await listAllKeys(
    archive,
    DESTINATION_PREFIX,
  );

  for (const key of destinationKeys) {
    if (!key.endsWith("/current.json")) {
      continue;
    }

    const pointer = await readJson(archive, key);
    if (!pointer || pointer.status !== "active") {
      continue;
    }

    incrementVersion(
      destinationCounts,
      unknown.destination,
      pointer.keyVersion,
    );
  }

  const idempotencyKeys = await listAllKeys(
    archive,
    IDEMPOTENCY_PREFIX,
  );

  for (const key of idempotencyKeys) {
    if (!key.endsWith(".json")) continue;

    const record = await readJson(archive, key);
    if (
      !record ||
      record.kind !== "public_idempotency" ||
      (record.status !== "processing" &&
        record.status !== "completed")
    ) {
      continue;
    }

    const replayUntil = new Date(
      record.replayUntil,
    );
    if (
      Number.isNaN(replayUntil.getTime()) ||
      replayUntil.getTime() <= timestamp.getTime()
    ) {
      continue;
    }

    incrementVersion(
      idempotencyCounts,
      unknown.idempotency,
      record.keyVersion,
    );
  }

  return {
    version: 1,
    observedAt: timestamp.toISOString(),
    destination: formatUsage(
      "activePointers",
      destinationCounts,
      unknown.destination,
    ),
    idempotency: formatUsage(
      "unexpiredCapsules",
      idempotencyCounts,
      unknown.idempotency,
    ),
  };
}

async function listAllKeys(
  archive,
  prefix,
) {
  const keys = [];
  let cursor;

  do {
    const result = await archive.list({
      prefix,
      ...(cursor ? { cursor } : {}),
    });

    for (const object of result?.objects || []) {
      if (typeof object?.key === "string") {
        keys.push(object.key);
      }
    }

    if (result?.truncated) {
      if (
        typeof result.cursor !== "string" ||
        result.cursor.length === 0
      ) {
        throw new EncryptionKeyUsageConfigurationError(
          "archive list was truncated without a cursor",
        );
      }
      cursor = result.cursor;
    } else {
      cursor = undefined;
    }
  } while (cursor);

  return keys;
}

function versionCounts() {
  return Object.fromEntries(
    ENCRYPTION_ROOT_VERSIONS.map(
      (version) => [version, 0],
    ),
  );
}

function incrementVersion(
  known,
  unknown,
  version,
) {
  if (
    typeof version === "string" &&
    Object.hasOwn(known, version)
  ) {
    known[version] += 1;
    return;
  }

  const key =
    typeof version === "string" &&
    version.length > 0
      ? version
      : "missing";

  unknown[key] = (unknown[key] || 0) + 1;
}

function formatUsage(
  countField,
  counts,
  unknownVersions,
) {
  const result = {};

  for (const version of ENCRYPTION_ROOT_VERSIONS) {
    const count = counts[version];
    result[version] = {
      [countField]: count,
      retirementSafe: count === 0,
    };
  }

  return {
    versions: result,
    unknownVersions,
    hasUnknownVersions:
      Object.keys(unknownVersions).length > 0,
  };
}

async function readJson(
  archive,
  key,
) {
  const object = await archive.get(key);
  if (!object) return null;

  const text =
    typeof object.text === "function"
      ? await object.text()
      : object.body != null
        ? await new Response(object.body).text()
        : null;

  if (text == null) {
    throw new EncryptionKeyUsageConfigurationError(
      `encryption key usage object has no readable body: ${key}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new EncryptionKeyUsageConfigurationError(
      `encryption key usage object is not valid JSON: ${key}`,
    );
  }
}

function normalizeDate(value) {
  const date =
    value instanceof Date
      ? value
      : new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new EncryptionKeyUsageConfigurationError(
      "encryption key usage timestamp is invalid",
    );
  }

  return date;
}

function requireListableArchive(archive) {
  if (
    !archive ||
    typeof archive.get !== "function" ||
    typeof archive.list !== "function"
  ) {
    throw new EncryptionKeyUsageConfigurationError(
      "archive bucket does not support encryption key usage audit",
    );
  }
}

export class EncryptionKeyUsageConfigurationError extends Error {}

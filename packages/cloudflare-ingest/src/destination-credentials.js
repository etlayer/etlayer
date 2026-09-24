import {
  isSupportedDestination,
  projectConfiguration,
  validateProjectId,
} from "./project-config.js";
import {
  EncryptionRootConfigurationError,
  activeEncryptionRootVersion,
  resolveEncryptionRootKey,
} from "./encryption-roots.js";

export const DESTINATION_CREDENTIAL_VERSION = 1;
export const DESTINATION_CREDENTIAL_KEY_VERSION = "v1";

const STATIC_SECRET_ENVS = {
  posthog: "POSTHOG_PROJECT_TOKEN",
  statsig: "STATSIG_SERVER_SECRET",
};

export function destinationCredentialVersionKey(
  projectId,
  destination,
  credentialId,
) {
  validateCoordinates(projectId, destination);
  validateCredentialId(credentialId);

  return [
    "registry/destination-credentials",
    encodeURIComponent(projectId),
    encodeURIComponent(destination),
    "versions",
    encodeURIComponent(credentialId) + ".json",
  ].join("/");
}

export function destinationCredentialCurrentKey(
  projectId,
  destination,
) {
  validateCoordinates(projectId, destination);

  return [
    "registry/destination-credentials",
    encodeURIComponent(projectId),
    encodeURIComponent(destination),
    "current.json",
  ].join("/");
}

export async function writeDestinationCredential(
  archive,
  env,
  {
    projectId,
    destination,
    secret,
    now = new Date(),
    crypto: cryptoImpl = globalThis.crypto,
    credentialId,
  },
) {
  requireArchive(archive);
  validateCoordinates(projectId, destination);
  validateSecret(secret);
  validateCrypto(cryptoImpl);

  if (projectConfiguration(projectId)) {
    throw new DestinationCredentialValidationError(
      "project-scoped destination credentials require a dynamic project",
    );
  }

  const id =
    credentialId || cryptoImpl.randomUUID?.();

  if (!id) {
    throw new DestinationCredentialConfigurationError(
      "credential id could not be generated",
    );
  }
  validateCredentialId(id);

  const timestamp = normalizeTimestamp(now);
  const keyVersion = destinationActiveKeyVersion(env);
  const masterKey = await importMasterKey(
    env,
    keyVersion,
    cryptoImpl,
  );
  const iv = new Uint8Array(12);
  cryptoImpl.getRandomValues(iv);
  const additionalData = credentialAdditionalData(
    projectId,
    destination,
    id,
    keyVersion,
  );

  const ciphertext = new Uint8Array(
    await cryptoImpl.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData,
        tagLength: 128,
      },
      masterKey,
      new TextEncoder().encode(secret),
    ),
  );

  const record = {
    version: DESTINATION_CREDENTIAL_VERSION,
    kind: "destination_credential",
    projectId,
    destination,
    credentialId: id,
    algorithm: "AES-256-GCM",
    keyVersion,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(ciphertext),
    createdAt: timestamp,
  };

  const versionKey = destinationCredentialVersionKey(
    projectId,
    destination,
    id,
  );

  const stored = await archive.put(
    versionKey,
    JSON.stringify(record),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
      customMetadata: {
        kind: "destination_credential",
        project_id: projectId,
        destination,
        credential_id: id,
        algorithm: record.algorithm,
        key_version: keyVersion,
        created_at: timestamp,
      },
    },
  );

  if (stored === null) {
    throw new DestinationCredentialConflictError(
      "destination credential version already exists",
    );
  }

  const pointer = {
    version: DESTINATION_CREDENTIAL_VERSION,
    kind: "destination_credential_pointer",
    projectId,
    destination,
    credentialId: id,
    status: "active",
    keyVersion,
    versionKey,
    updatedAt: timestamp,
  };

  await putJson(
    archive,
    destinationCredentialCurrentKey(
      projectId,
      destination,
    ),
    pointer,
    {
      kind: "destination_credential_pointer",
      project_id: projectId,
      destination,
      credential_id: id,
      status: pointer.status,
      key_version: keyVersion,
      updated_at: timestamp,
    },
  );

  return {
    pointer,
    record,
  };
}

export async function disableDestinationCredential(
  archive,
  {
    projectId,
    destination,
    now = new Date(),
  },
) {
  requireArchive(archive);
  validateCoordinates(projectId, destination);

  const current = await readDestinationCredentialPointer(
    archive,
    projectId,
    destination,
  );

  if (!current) {
    throw new DestinationCredentialNotFoundError(
      `destination credential not found: ${projectId}/${destination}`,
    );
  }

  if (current.status === "disabled") {
    return current;
  }

  const disabled = {
    ...current,
    status: "disabled",
    updatedAt: normalizeTimestamp(now),
  };

  await putJson(
    archive,
    destinationCredentialCurrentKey(
      projectId,
      destination,
    ),
    disabled,
    {
      kind: "destination_credential_pointer",
      project_id: projectId,
      destination,
      credential_id: disabled.credentialId,
      status: disabled.status,
      key_version: disabled.keyVersion,
      updated_at: disabled.updatedAt,
    },
  );

  return disabled;
}

export async function readDestinationCredentialStatus(
  archive,
  projectId,
  destination,
) {
  const pointer = await readDestinationCredentialPointer(
    archive,
    projectId,
    destination,
  );

  if (!pointer) {
    return {
      configured: false,
      projectId,
      destination,
      status: "missing",
      credentialId: null,
      keyVersion: null,
      algorithm: null,
      createdAt: null,
      updatedAt: null,
    };
  }

  const record = await readJson(
    archive,
    pointer.versionKey,
  );

  return {
    configured: pointer.status === "active",
    projectId,
    destination,
    status: pointer.status,
    credentialId: pointer.credentialId,
    keyVersion: pointer.keyVersion,
    algorithm: record?.algorithm || null,
    createdAt: record?.createdAt || null,
    updatedAt: pointer.updatedAt,
  };
}

export function runtimeDefaultDestinationSecret(
  env,
  destination,
) {
  if (!isSupportedDestination(destination)) {
    throw new DestinationCredentialValidationError(
      `unsupported destination: ${String(destination)}`,
    );
  }

  const envName = STATIC_SECRET_ENVS[destination];
  const secret = envName ? env?.[envName] : null;

  return {
    envName,
    secret:
      typeof secret === "string" && secret.length > 0
        ? secret
        : null,
  };
}

export async function resolveDestinationCredential(
  archive,
  env,
  projectId,
  destination,
  options = {},
) {
  validateCoordinates(projectId, destination);

  const staticProject = projectConfiguration(projectId);
  if (staticProject) {
    const { secret } = runtimeDefaultDestinationSecret(
      env,
      destination,
    );

    return {
      configured: secret != null,
      source: "worker_secret",
      projectId,
      destination,
      credentialId: null,
      keyVersion: null,
      secret,
    };
  }

  requireArchive(archive);

  const pointer = await readDestinationCredentialPointer(
    archive,
    projectId,
    destination,
  );

  if (!pointer || pointer.status !== "active") {
    return {
      configured: false,
      source: "project_encrypted",
      projectId,
      destination,
      credentialId: pointer?.credentialId || null,
      keyVersion: pointer?.keyVersion || null,
      secret: null,
    };
  }

  const record = await readJson(
    archive,
    pointer.versionKey,
  );

  if (
    !record ||
    record.projectId !== projectId ||
    record.destination !== destination ||
    record.credentialId !== pointer.credentialId ||
    record.keyVersion !== pointer.keyVersion
  ) {
    throw new DestinationCredentialConfigurationError(
      "active destination credential record does not match pointer",
    );
  }

  const cryptoImpl =
    options.crypto || globalThis.crypto;
  validateCrypto(cryptoImpl);

  const masterKey = await importMasterKey(
    env,
    record.keyVersion,
    cryptoImpl,
  );
  const iv = base64UrlDecode(record.iv);
  const ciphertext = base64UrlDecode(record.ciphertext);
  const additionalData = credentialAdditionalData(
    projectId,
    destination,
    record.credentialId,
    record.keyVersion,
  );

  let plaintext;
  try {
    plaintext = await cryptoImpl.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData,
        tagLength: 128,
      },
      masterKey,
      ciphertext,
    );
  } catch {
    throw new DestinationCredentialDecryptionError(
      `destination credential could not be decrypted: ${projectId}/${destination}`,
    );
  }

  return {
    configured: true,
    source: "project_encrypted",
    projectId,
    destination,
    credentialId: record.credentialId,
    keyVersion: record.keyVersion,
    secret: new TextDecoder().decode(plaintext),
  };
}

export async function readDestinationCredentialPointer(
  archive,
  projectId,
  destination,
) {
  if (!archive || typeof archive.get !== "function") {
    return null;
  }

  validateCoordinates(projectId, destination);
  return readJson(
    archive,
    destinationCredentialCurrentKey(
      projectId,
      destination,
    ),
  );
}

function credentialAdditionalData(
  projectId,
  destination,
  credentialId,
  keyVersion,
) {
  return new TextEncoder().encode(
    [
      "etlayer-destination-credential",
      String(DESTINATION_CREDENTIAL_VERSION),
      projectId,
      destination,
      credentialId,
      keyVersion,
    ].join("\0"),
  );
}

async function importMasterKey(
  env,
  keyVersion,
  cryptoImpl,
) {
  try {
    return await resolveEncryptionRootKey(
      env,
      {
        domain: "destination",
        version: keyVersion,
        crypto: cryptoImpl,
      },
    );
  } catch (error) {
    if (error instanceof EncryptionRootConfigurationError) {
      throw new DestinationCredentialConfigurationError(
        error.message,
      );
    }
    throw error;
  }
}

function destinationActiveKeyVersion(env) {
  try {
    return activeEncryptionRootVersion(
      env,
      "destination",
    );
  } catch (error) {
    if (error instanceof EncryptionRootConfigurationError) {
      throw new DestinationCredentialConfigurationError(
        error.message,
      );
    }
    throw error;
  }
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new DestinationCredentialConfigurationError(
      "encrypted credential encoding is invalid",
    );
  }

  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);

  return Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
}

async function readJson(archive, key) {
  if (!archive || typeof archive.get !== "function") {
    return null;
  }

  const object = await archive.get(key);
  if (!object) return null;

  const text =
    typeof object.text === "function"
      ? await object.text()
      : object.body != null
        ? await new Response(object.body).text()
        : null;

  if (text == null) {
    throw new DestinationCredentialConfigurationError(
      `destination credential object has no readable body: ${key}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new DestinationCredentialConfigurationError(
      `destination credential object is not valid JSON: ${key}`,
    );
  }
}

async function putJson(
  archive,
  key,
  value,
  customMetadata,
) {
  await archive.put(key, JSON.stringify(value), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    customMetadata,
  });
}

function validateCoordinates(projectId, destination) {
  validateProjectId(projectId);

  if (!isSupportedDestination(destination)) {
    throw new DestinationCredentialValidationError(
      `unsupported destination: ${String(destination)}`,
    );
  }
}

function validateCredentialId(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("/") ||
    value.includes("..")
  ) {
    throw new DestinationCredentialValidationError(
      "credential id must be a non-empty path-safe string",
    );
  }
}

function validateSecret(secret) {
  if (
    typeof secret !== "string" ||
    secret.length === 0
  ) {
    throw new DestinationCredentialValidationError(
      "destination credential secret must be a non-empty string",
    );
  }
}

function validateCrypto(cryptoImpl) {
  if (
    !cryptoImpl?.subtle ||
    typeof cryptoImpl.getRandomValues !== "function"
  ) {
    throw new DestinationCredentialConfigurationError(
      "Web Crypto is required for destination credential encryption",
    );
  }
}

function normalizeTimestamp(value) {
  const date =
    value instanceof Date
      ? value
      : new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new DestinationCredentialValidationError(
      "destination credential timestamp is invalid",
    );
  }

  return date.toISOString();
}

function requireArchive(archive) {
  if (
    !archive ||
    typeof archive.get !== "function" ||
    typeof archive.put !== "function"
  ) {
    throw new DestinationCredentialConfigurationError(
      "archive bucket is not configured for destination credentials",
    );
  }
}

export class DestinationCredentialValidationError extends Error {}
export class DestinationCredentialConfigurationError extends Error {}
export class DestinationCredentialConflictError extends Error {}
export class DestinationCredentialNotFoundError extends Error {}
export class DestinationCredentialDecryptionError extends Error {}

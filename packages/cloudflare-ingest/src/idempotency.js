export const IDEMPOTENCY_VERSION = 1;
export const IDEMPOTENCY_KEY_VERSION = "v1";
export const DEFAULT_IDEMPOTENCY_REPLAY_SECONDS = 24 * 60 * 60;

export function idempotencyRecordKey(
  projectId,
  operation,
  keyFingerprint,
) {
  validatePathPart(projectId, "project id");
  validatePathPart(operation, "operation");

  if (!/^[0-9a-f]{64}$/.test(keyFingerprint)) {
    throw new IdempotencyValidationError(
      "idempotency key fingerprint must be sha256 hex",
    );
  }

  return [
    "registry/idempotency",
    encodeURIComponent(projectId),
    encodeURIComponent(operation),
    keyFingerprint + ".json",
  ].join("/");
}

export async function fingerprintIdempotencyKey(
  value,
  cryptoImpl = globalThis.crypto,
) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 255
  ) {
    throw new IdempotencyValidationError(
      "idempotency key must be a non-empty string up to 255 characters",
    );
  }

  return sha256Hex(value, cryptoImpl);
}

export async function fingerprintSemanticRequest(
  value,
  cryptoImpl = globalThis.crypto,
) {
  return sha256Hex(
    stableJson(value),
    cryptoImpl,
  );
}

export async function beginIdempotentOperation(
  archive,
  env,
  {
    projectId,
    operation,
    idempotencyKey,
    requestFingerprint,
    recoveryPayload,
    now = new Date(),
    replaySeconds =
      DEFAULT_IDEMPOTENCY_REPLAY_SECONDS,
    crypto: cryptoImpl = globalThis.crypto,
  },
) {
  requireArchive(archive);
  validateCrypto(cryptoImpl);

  if (
    typeof requestFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(requestFingerprint)
  ) {
    throw new IdempotencyValidationError(
      "request fingerprint must be sha256 hex",
    );
  }

  if (
    !Number.isInteger(replaySeconds) ||
    replaySeconds <= 0
  ) {
    throw new IdempotencyValidationError(
      "idempotency replay seconds must be a positive integer",
    );
  }

  const timestamp = normalizeDate(now);
  const keyFingerprint =
    await fingerprintIdempotencyKey(
      idempotencyKey,
      cryptoImpl,
    );
  const key = idempotencyRecordKey(
    projectId,
    operation,
    keyFingerprint,
  );

  let record = await readJson(archive, key);
  if (!record) {
    const replayUntil = new Date(
      timestamp.getTime() + replaySeconds * 1000,
    ).toISOString();

    const encrypted = await encryptCapsule(
      env,
      {
        projectId,
        operation,
        keyFingerprint,
        requestFingerprint,
        payload: recoveryPayload,
        cryptoImpl,
      },
    );

    const processing = {
      version: IDEMPOTENCY_VERSION,
      kind: "public_idempotency",
      projectId,
      operation,
      keyFingerprint,
      requestFingerprint,
      status: "processing",
      algorithm: "AES-256-GCM",
      keyVersion: IDEMPOTENCY_KEY_VERSION,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
      replayUntil,
    };

    const stored = await archive.put(
      key,
      JSON.stringify(processing),
      {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: {
          contentType:
            "application/json; charset=utf-8",
        },
        customMetadata: {
          kind: "public_idempotency",
          project_id: projectId,
          operation,
          key_fingerprint: keyFingerprint,
          request_fingerprint: requestFingerprint,
          status: processing.status,
          key_version: processing.keyVersion,
          replay_until: replayUntil,
        },
      },
    );

    record = stored === null
      ? await readJson(archive, key)
      : processing;
  }

  validateExistingRecord(
    record,
    {
      projectId,
      operation,
      keyFingerprint,
      requestFingerprint,
      now: timestamp,
    },
  );

  const payload = await decryptCapsule(
    env,
    record,
    cryptoImpl,
  );

  return {
    key,
    record,
    payload,
    replayed: record.status === "completed",
  };
}

export async function completeIdempotentOperation(
  archive,
  env,
  {
    key,
    record,
    responsePayload,
    now = new Date(),
    crypto: cryptoImpl = globalThis.crypto,
  },
) {
  requireArchive(archive);
  validateCrypto(cryptoImpl);

  if (
    !record ||
    record.status !== "processing"
  ) {
    if (record?.status === "completed") {
      return record;
    }

    throw new IdempotencyConfigurationError(
      "idempotency operation is not processing",
    );
  }

  const encrypted = await encryptCapsule(
    env,
    {
      projectId: record.projectId,
      operation: record.operation,
      keyFingerprint: record.keyFingerprint,
      requestFingerprint: record.requestFingerprint,
      payload: responsePayload,
      cryptoImpl,
    },
  );

  const completed = {
    ...record,
    status: "completed",
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    updatedAt: normalizeDate(now).toISOString(),
  };

  await archive.put(
    key,
    JSON.stringify(completed),
    {
      httpMetadata: {
        contentType:
          "application/json; charset=utf-8",
      },
      customMetadata: {
        kind: "public_idempotency",
        project_id: completed.projectId,
        operation: completed.operation,
        key_fingerprint: completed.keyFingerprint,
        request_fingerprint:
          completed.requestFingerprint,
        status: completed.status,
        key_version: completed.keyVersion,
        replay_until: completed.replayUntil,
      },
    },
  );

  return completed;
}

function validateExistingRecord(
  record,
  {
    projectId,
    operation,
    keyFingerprint,
    requestFingerprint,
    now,
  },
) {
  if (
    !record ||
    record.version !== IDEMPOTENCY_VERSION ||
    record.kind !== "public_idempotency" ||
    record.projectId !== projectId ||
    record.operation !== operation ||
    record.keyFingerprint !== keyFingerprint
  ) {
    throw new IdempotencyConfigurationError(
      "idempotency record does not match lookup coordinates",
    );
  }

  if (
    record.requestFingerprint !==
    requestFingerprint
  ) {
    throw new IdempotencyKeyReusedError(
      "idempotency key was already used with a different request",
    );
  }

  const replayUntil = new Date(record.replayUntil);
  if (
    Number.isNaN(replayUntil.getTime()) ||
    now.getTime() > replayUntil.getTime()
  ) {
    throw new IdempotencyKeyExpiredError(
      "idempotency replay window has expired",
    );
  }

  if (
    record.status !== "processing" &&
    record.status !== "completed"
  ) {
    throw new IdempotencyConfigurationError(
      "idempotency record has unsupported status",
    );
  }
}

async function encryptCapsule(
  env,
  {
    projectId,
    operation,
    keyFingerprint,
    requestFingerprint,
    payload,
    cryptoImpl,
  },
) {
  const masterKey = await importMasterKey(
    env,
    IDEMPOTENCY_KEY_VERSION,
    cryptoImpl,
  );
  const iv = new Uint8Array(12);
  cryptoImpl.getRandomValues(iv);
  const additionalData = capsuleAdditionalData(
    projectId,
    operation,
    keyFingerprint,
    requestFingerprint,
    IDEMPOTENCY_KEY_VERSION,
  );
  const plaintext = new TextEncoder().encode(
    JSON.stringify(payload),
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
      plaintext,
    ),
  );

  return {
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(ciphertext),
  };
}

async function decryptCapsule(
  env,
  record,
  cryptoImpl,
) {
  const masterKey = await importMasterKey(
    env,
    record.keyVersion,
    cryptoImpl,
  );

  try {
    const plaintext = await cryptoImpl.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlDecode(record.iv),
        additionalData: capsuleAdditionalData(
          record.projectId,
          record.operation,
          record.keyFingerprint,
          record.requestFingerprint,
          record.keyVersion,
        ),
        tagLength: 128,
      },
      masterKey,
      base64UrlDecode(record.ciphertext),
    );

    return JSON.parse(
      new TextDecoder().decode(plaintext),
    );
  } catch {
    throw new IdempotencyDecryptionError(
      "idempotency replay capsule could not be decrypted",
    );
  }
}

function capsuleAdditionalData(
  projectId,
  operation,
  keyFingerprint,
  requestFingerprint,
  keyVersion,
) {
  return new TextEncoder().encode(
    [
      "etlayer-public-idempotency",
      String(IDEMPOTENCY_VERSION),
      projectId,
      operation,
      keyFingerprint,
      requestFingerprint,
      keyVersion,
    ].join("\0"),
  );
}

async function importMasterKey(
  env,
  keyVersion,
  cryptoImpl,
) {
  const envName =
    keyVersion === "v1"
      ? "ETLAYER_IDEMPOTENCY_SECRET_KEY_V1"
      : null;

  if (!envName) {
    throw new IdempotencyConfigurationError(
      `unsupported idempotency key version: ${keyVersion}`,
    );
  }

  const encoded = env?.[envName];
  if (
    typeof encoded !== "string" ||
    encoded.length === 0
  ) {
    throw new IdempotencyConfigurationError(
      `${envName} is required for public idempotency`,
    );
  }

  const raw = decodeMasterKey(encoded);
  if (raw.byteLength !== 32) {
    throw new IdempotencyConfigurationError(
      `${envName} must decode to exactly 32 bytes`,
    );
  }

  return cryptoImpl.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function sha256Hex(
  value,
  cryptoImpl,
) {
  if (!cryptoImpl?.subtle) {
    throw new IdempotencyConfigurationError(
      "Web Crypto is required for idempotency hashing",
    );
  }

  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return (
      "[" +
      value.map((item) => stableJson(item)).join(",") +
      "]"
    );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            stableJson(value[key]),
        )
        .join(",") +
      "}"
    );
  }

  return JSON.stringify(value);
}

async function readJson(archive, key) {
  const object = await archive.get(key);
  if (!object) return null;

  const text =
    typeof object.text === "function"
      ? await object.text()
      : object.body != null
        ? await new Response(object.body).text()
        : null;

  if (text == null) {
    throw new IdempotencyConfigurationError(
      `idempotency object has no readable body: ${key}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new IdempotencyConfigurationError(
      `idempotency object is not valid JSON: ${key}`,
    );
  }
}

function decodeMasterKey(value) {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = Number.parseInt(
        value.slice(index * 2, index * 2 + 2),
        16,
      );
    }
    return bytes;
  }

  return base64UrlDecode(value);
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
    throw new IdempotencyConfigurationError(
      "idempotency capsule encoding is invalid",
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

function validatePathPart(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value)
  ) {
    throw new IdempotencyValidationError(
      `${label} must be a lowercase path-safe slug`,
    );
  }
}

function normalizeDate(value) {
  const date =
    value instanceof Date
      ? value
      : new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new IdempotencyValidationError(
      "idempotency timestamp is invalid",
    );
  }

  return date;
}

function requireArchive(archive) {
  if (
    !archive ||
    typeof archive.get !== "function" ||
    typeof archive.put !== "function"
  ) {
    throw new IdempotencyConfigurationError(
      "archive bucket is not configured for idempotency",
    );
  }
}

function validateCrypto(cryptoImpl) {
  if (
    !cryptoImpl?.subtle ||
    typeof cryptoImpl.getRandomValues !== "function"
  ) {
    throw new IdempotencyConfigurationError(
      "Web Crypto is required for idempotency encryption",
    );
  }
}

export class IdempotencyValidationError extends Error {}
export class IdempotencyConfigurationError extends Error {}
export class IdempotencyKeyReusedError extends Error {}
export class IdempotencyKeyExpiredError extends Error {}
export class IdempotencyDecryptionError extends Error {}

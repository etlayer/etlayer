export const ENCRYPTION_ROOT_VERSIONS = ["v1", "v2"];

const DOMAINS = {
  destination: {
    activeEnv:
      "ETLAYER_DESTINATION_SECRET_ACTIVE_VERSION",
    keyEnvPrefix:
      "ETLAYER_DESTINATION_SECRET_KEY_",
  },
  idempotency: {
    activeEnv:
      "ETLAYER_IDEMPOTENCY_SECRET_ACTIVE_VERSION",
    keyEnvPrefix:
      "ETLAYER_IDEMPOTENCY_SECRET_KEY_",
  },
};

export function activeEncryptionRootVersion(
  env,
  domain,
) {
  const config = domainConfig(domain);
  const configured = env?.[config.activeEnv];

  if (configured == null || configured === "") {
    return "v1";
  }

  const version = normalizeVersion(configured);
  if (!ENCRYPTION_ROOT_VERSIONS.includes(version)) {
    throw new EncryptionRootConfigurationError(
      `${config.activeEnv} must be one of: ${ENCRYPTION_ROOT_VERSIONS.join(", ")}`,
    );
  }

  return version;
}

export function encryptionRootEnvName(
  domain,
  version,
) {
  const config = domainConfig(domain);
  const normalized = normalizeVersion(version);

  if (!ENCRYPTION_ROOT_VERSIONS.includes(normalized)) {
    throw new EncryptionRootConfigurationError(
      `unsupported ${domain} encryption root version: ${String(version)}`,
    );
  }

  return (
    config.keyEnvPrefix +
    normalized.toUpperCase()
  );
}

export async function resolveEncryptionRootKey(
  env,
  {
    domain,
    version,
    crypto: cryptoImpl = globalThis.crypto,
  },
) {
  validateCrypto(cryptoImpl);

  const envName = encryptionRootEnvName(
    domain,
    version,
  );
  const encoded = env?.[envName];

  if (
    typeof encoded !== "string" ||
    encoded.length === 0
  ) {
    throw new EncryptionRootConfigurationError(
      `${envName} is required for ${domain} encryption root ${version}`,
    );
  }

  const raw = decodeRootKey(encoded);
  if (raw.byteLength !== 32) {
    throw new EncryptionRootConfigurationError(
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

function domainConfig(domain) {
  const config = DOMAINS[domain];
  if (!config) {
    throw new EncryptionRootConfigurationError(
      `unsupported encryption domain: ${String(domain)}`,
    );
  }
  return config;
}

function normalizeVersion(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase()
    : "";
}

function decodeRootKey(value) {
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

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new EncryptionRootConfigurationError(
      "encryption root encoding is invalid",
    );
  }

  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);

  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new EncryptionRootConfigurationError(
      "encryption root encoding is invalid",
    );
  }

  return Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
}

function validateCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle) {
    throw new EncryptionRootConfigurationError(
      "Web Crypto is required for encryption roots",
    );
  }
}

export class EncryptionRootConfigurationError extends Error {}

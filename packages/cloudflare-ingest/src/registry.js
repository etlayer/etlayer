const REGISTRY_VERSION = 1;

export function projectRegistryKey(projectId) {
  return `registry/projects/${encodeId(projectId)}.json`;
}

export function operatorCredentialKey(fingerprint) {
  return `registry/operators/${encodeFingerprint(fingerprint)}.json`;
}

export function producerRegistryKey(projectId, producerId) {
  return `registry/producers/${encodeId(projectId)}/${encodeId(producerId)}.json`;
}

export function producerCredentialKey(fingerprint) {
  return `registry/producer-credentials/${encodeFingerprint(fingerprint)}.json`;
}

export async function readRegistryProject(archive, projectId) {
  return readJson(archive, projectRegistryKey(projectId));
}

export async function readRegistryProducer(
  archive,
  projectId,
  producerId,
) {
  return readJson(
    archive,
    producerRegistryKey(projectId, producerId),
  );
}

export async function readOperatorCredential(
  archive,
  fingerprint,
) {
  return readJson(
    archive,
    operatorCredentialKey(fingerprint),
  );
}

export async function readProducerCredential(
  archive,
  fingerprint,
) {
  return readJson(
    archive,
    producerCredentialKey(fingerprint),
  );
}

export async function createRegistryProject(
  archive,
  {
    projectId,
    operatorFingerprint,
    destinations = [],
    now = new Date(),
  },
) {
  requireArchive(archive);
  const timestamp = now.toISOString();
  const project = {
    version: REGISTRY_VERSION,
    id: projectId,
    status: "active",
    operatorFingerprint,
    destinations: [...destinations],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const operator = {
    version: REGISTRY_VERSION,
    kind: "operator",
    projectId,
    fingerprint: operatorFingerprint,
    status: "active",
    createdAt: timestamp,
  };

  const projectStored = await putCreateOnly(
    archive,
    projectRegistryKey(projectId),
    project,
    {
      kind: "project",
      project_id: projectId,
      status: project.status,
    },
  );

  if (!projectStored) {
    throw new RegistryConflictError(
      `project already exists: ${projectId}`,
    );
  }

  const operatorStored = await putCreateOnly(
    archive,
    operatorCredentialKey(operatorFingerprint),
    operator,
    {
      kind: "operator_credential",
      project_id: projectId,
      status: operator.status,
    },
  );

  if (!operatorStored) {
    throw new RegistryConflictError(
      "operator credential fingerprint already exists",
    );
  }

  return { project, operator };
}

export async function createRegistryProducer(
  archive,
  {
    projectId,
    producerId,
    profile,
    credentialFingerprint,
    now = new Date(),
  },
) {
  requireArchive(archive);
  const timestamp = now.toISOString();
  const producer = {
    version: REGISTRY_VERSION,
    id: producerId,
    projectId,
    status: "active",
    profileId: profile.profileId,
    producerKind: profile.producerKind,
    allowedAuthorityKinds: [
      ...profile.allowedAuthorityKinds,
    ],
    credentialFingerprint,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const credential = producerCredentialRecord(
    producer,
    credentialFingerprint,
    timestamp,
  );

  const producerStored = await putCreateOnly(
    archive,
    producerRegistryKey(projectId, producerId),
    producer,
    {
      kind: "producer",
      project_id: projectId,
      producer_id: producerId,
      status: producer.status,
    },
  );

  if (!producerStored) {
    throw new RegistryConflictError(
      `producer already exists: ${projectId}/${producerId}`,
    );
  }

  const credentialStored = await putCreateOnly(
    archive,
    producerCredentialKey(credentialFingerprint),
    credential,
    {
      kind: "producer_credential",
      project_id: projectId,
      producer_id: producerId,
      status: credential.status,
    },
  );

  if (!credentialStored) {
    throw new RegistryConflictError(
      "producer credential fingerprint already exists",
    );
  }

  return { producer, credential };
}

export async function rotateRegistryProducer(
  archive,
  {
    projectId,
    producerId,
    credentialFingerprint,
    now = new Date(),
  },
) {
  requireArchive(archive);
  const producer = await readRegistryProducer(
    archive,
    projectId,
    producerId,
  );

  if (!producer) {
    throw new RegistryNotFoundError(
      `producer not found: ${projectId}/${producerId}`,
    );
  }

  if (producer.status !== "active") {
    throw new RegistryStateError(
      `producer is not active: ${projectId}/${producerId}`,
    );
  }

  const timestamp = now.toISOString();
  const previousFingerprint =
    producer.credentialFingerprint;
  const nextProducer = {
    ...producer,
    credentialFingerprint,
    updatedAt: timestamp,
  };
  const credential = producerCredentialRecord(
    nextProducer,
    credentialFingerprint,
    timestamp,
  );

  const credentialStored = await putCreateOnly(
    archive,
    producerCredentialKey(credentialFingerprint),
    credential,
    {
      kind: "producer_credential",
      project_id: projectId,
      producer_id: producerId,
      status: credential.status,
    },
  );

  if (!credentialStored) {
    throw new RegistryConflictError(
      "producer credential fingerprint already exists",
    );
  }

  await putJson(
    archive,
    producerRegistryKey(projectId, producerId),
    nextProducer,
    {
      kind: "producer",
      project_id: projectId,
      producer_id: producerId,
      status: nextProducer.status,
    },
  );

  if (previousFingerprint) {
    const previous = await readProducerCredential(
      archive,
      previousFingerprint,
    );

    if (previous) {
      await putJson(
        archive,
        producerCredentialKey(previousFingerprint),
        {
          ...previous,
          status: "superseded",
          supersededAt: timestamp,
        },
        {
          kind: "producer_credential",
          project_id: projectId,
          producer_id: producerId,
          status: "superseded",
        },
      );
    }
  }

  return {
    producer: nextProducer,
    credential,
    previousFingerprint,
  };
}

export async function disableRegistryProducer(
  archive,
  {
    projectId,
    producerId,
    now = new Date(),
  },
) {
  requireArchive(archive);
  const producer = await readRegistryProducer(
    archive,
    projectId,
    producerId,
  );

  if (!producer) {
    throw new RegistryNotFoundError(
      `producer not found: ${projectId}/${producerId}`,
    );
  }

  if (producer.status === "disabled") {
    return producer;
  }

  const disabled = {
    ...producer,
    status: "disabled",
    disabledAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await putJson(
    archive,
    producerRegistryKey(projectId, producerId),
    disabled,
    {
      kind: "producer",
      project_id: projectId,
      producer_id: producerId,
      status: disabled.status,
    },
  );

  return disabled;
}

export async function setRegistryDestination(
  archive,
  {
    projectId,
    destination,
    enabled,
    now = new Date(),
  },
) {
  requireArchive(archive);
  const project = await readRegistryProject(
    archive,
    projectId,
  );

  if (!project) {
    throw new RegistryNotFoundError(
      `project not found: ${projectId}`,
    );
  }

  if (project.status !== "active") {
    throw new RegistryStateError(
      `project is not active: ${projectId}`,
    );
  }

  const destinations = new Set(project.destinations || []);
  if (enabled) destinations.add(destination);
  else destinations.delete(destination);

  const updated = {
    ...project,
    destinations: [...destinations].sort(),
    updatedAt: now.toISOString(),
  };

  await putJson(
    archive,
    projectRegistryKey(projectId),
    updated,
    {
      kind: "project",
      project_id: projectId,
      status: updated.status,
    },
  );

  return updated;
}

export async function credentialFingerprint(
  credential,
  cryptoImpl = globalThis.crypto,
) {
  if (
    typeof credential !== "string" ||
    credential.length === 0
  ) {
    throw new RegistryValidationError(
      "credential must be a non-empty string",
    );
  }

  if (!cryptoImpl?.subtle) {
    throw new RegistryConfigurationError(
      "Web Crypto is required to fingerprint credentials",
    );
  }

  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(credential),
  );

  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function generateCredential(
  prefix,
  cryptoImpl = globalThis.crypto,
) {
  if (!cryptoImpl?.getRandomValues) {
    throw new RegistryConfigurationError(
      "Web Crypto is required to generate credentials",
    );
  }

  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  const value = base64Url(bytes);
  return `${prefix}_${value}`;
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
    throw new RegistryConfigurationError(
      `registry object has no readable body: ${key}`,
    );
  }

  return JSON.parse(text);
}

async function putCreateOnly(
  archive,
  key,
  value,
  customMetadata,
) {
  const stored = await archive.put(
    key,
    JSON.stringify(value),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
      customMetadata,
    },
  );

  return stored !== null;
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

function producerCredentialRecord(
  producer,
  fingerprint,
  createdAt,
) {
  return {
    version: REGISTRY_VERSION,
    kind: "producer",
    projectId: producer.projectId,
    producerId: producer.id,
    profileId: producer.profileId,
    producerKind: producer.producerKind,
    allowedAuthorityKinds: [
      ...producer.allowedAuthorityKinds,
    ],
    fingerprint,
    status: "active",
    createdAt,
  };
}

function encodeId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value)
  ) {
    throw new RegistryValidationError(
      "registry id must be a lowercase slug",
    );
  }

  return encodeURIComponent(value);
}

function encodeFingerprint(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{64}$/.test(value)
  ) {
    throw new RegistryValidationError(
      "credential fingerprint must be sha256 hex",
    );
  }

  return value;
}

function requireArchive(archive) {
  if (
    !archive ||
    typeof archive.get !== "function" ||
    typeof archive.put !== "function"
  ) {
    throw new RegistryConfigurationError(
      "archive bucket is not configured for registry",
    );
  }
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export class RegistryConflictError extends Error {}
export class RegistryNotFoundError extends Error {}
export class RegistryStateError extends Error {}
export class RegistryValidationError extends Error {}
export class RegistryConfigurationError extends Error {}

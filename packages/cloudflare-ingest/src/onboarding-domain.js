import {
  isSupportedDestination,
  profileTemplate,
  projectConfiguration,
  validateProjectId,
} from "./project-config.js";
import {
  RegistryConflictError,
  createRegistryProducer,
  credentialFingerprint,
  readRegistryProducer,
  readRegistryProject,
  setRegistryDestination,
} from "./registry.js";

export function normalizeOnboardingRequest(input) {
  const producerId =
    typeof input?.producerId === "string" &&
    input.producerId.length > 0
      ? input.producerId
      : "backend-main";

  validateProducerId(producerId);

  const requestedDestinations = input?.destinations;
  if (
    !Array.isArray(requestedDestinations) ||
    requestedDestinations.length === 0
  ) {
    throw new OnboardingValidationError(
      "destinations must be a non-empty array",
    );
  }

  const destinations = [
    ...new Set(requestedDestinations),
  ].sort();

  for (const destination of destinations) {
    if (
      typeof destination !== "string" ||
      !isSupportedDestination(destination)
    ) {
      throw new OnboardingValidationError(
        "destinations may contain only supported destination names",
      );
    }
  }

  return {
    producerId,
    destinations,
  };
}

export async function ensureOnboarding(
  archive,
  {
    projectId,
    producerId,
    destinations,
    credential,
    now = new Date(),
    crypto: cryptoImpl = globalThis.crypto,
  },
) {
  validateProjectId(projectId);

  if (projectConfiguration(projectId)) {
    throw new OnboardingValidationError(
      "external onboarding requires a dynamic project",
    );
  }

  const project = await readRegistryProject(
    archive,
    projectId,
  );
  if (!project || project.status !== "active") {
    throw new OnboardingNotFoundError(
      "project not found",
    );
  }

  const profile = profileTemplate("backend");
  const fingerprint = await credentialFingerprint(
    credential,
    cryptoImpl,
  );

  let producer = await readRegistryProducer(
    archive,
    projectId,
    producerId,
  );

  if (!producer) {
    try {
      const created = await createRegistryProducer(
        archive,
        {
          projectId,
          producerId,
          profile,
          credentialFingerprint: fingerprint,
          now,
        },
      );
      producer = created.producer;
    } catch (error) {
      if (!(error instanceof RegistryConflictError)) {
        throw error;
      }

      producer = await readRegistryProducer(
        archive,
        projectId,
        producerId,
      );
    }
  }

  if (
    !producer ||
    producer.status !== "active" ||
    producer.profileId !== profile.profileId ||
    producer.producerKind !== profile.producerKind ||
    producer.credentialFingerprint !== fingerprint
  ) {
    throw new OnboardingConflictError(
      `producer already exists with incompatible state: ${projectId}/${producerId}`,
    );
  }

  let updatedProject = project;
  for (const destination of destinations) {
    updatedProject = await setRegistryDestination(
      archive,
      {
        projectId,
        destination,
        enabled: true,
        now,
      },
    );
  }

  return {
    project: publicProject(updatedProject),
    producer: publicProducer(producer),
    destinations: [
      ...(updatedProject.destinations || []),
    ],
  };
}

export function publicProject(project) {
  return {
    version: project.version,
    id: project.id,
    status: project.status,
    destinations: [...(project.destinations || [])],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function publicProducer(producer) {
  return {
    version: producer.version,
    id: producer.id,
    projectId: producer.projectId,
    status: producer.status,
    profileId: producer.profileId,
    producerKind: producer.producerKind,
    allowedAuthorityKinds: [
      ...(producer.allowedAuthorityKinds || []),
    ],
    createdAt: producer.createdAt,
    updatedAt: producer.updatedAt,
    disabledAt: producer.disabledAt || null,
  };
}

function validateProducerId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value)
  ) {
    throw new OnboardingValidationError(
      "producer id must be a lowercase slug",
    );
  }
}

export class OnboardingValidationError extends Error {}
export class OnboardingConflictError extends Error {}
export class OnboardingNotFoundError extends Error {}

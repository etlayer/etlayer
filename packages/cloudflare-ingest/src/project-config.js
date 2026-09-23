import { readRegistryProject } from "./registry.js";

export const DEFAULT_PROJECT_ID = "etlayer-default";
export const SECONDARY_PROJECT_ID = "etlayer-secondary";

export const SUPPORTED_DESTINATIONS = [
  "posthog",
  "statsig",
];

const PROFILE_TEMPLATES = {
  browser: {
    profileId: "browser",
    producerKind: "browser",
    allowedAuthorityKinds: ["interaction"],
  },
  backend: {
    profileId: "backend",
    producerKind: "backend",
    allowedAuthorityKinds: ["business_state"],
  },
  "agent-runtime": {
    profileId: "agent-runtime",
    producerKind: "agent_runtime",
    allowedAuthorityKinds: ["agent_runtime"],
  },
  legacy: {
    profileId: "legacy",
    producerKind: "legacy",
    allowedAuthorityKinds: [],
  },
};

const PROJECTS = [
  {
    id: DEFAULT_PROJECT_ID,
    operatorSecretEnv: "ETLAYER_REPLAY_KEY",
    destinations: ["posthog", "statsig"],
    profiles: [
      {
        secretEnv: "ETLAYER_BROWSER_INGEST_KEY",
        ...PROFILE_TEMPLATES.browser,
      },
      {
        secretEnv: "ETLAYER_BACKEND_INGEST_KEY",
        ...PROFILE_TEMPLATES.backend,
      },
      {
        secretEnv: "ETLAYER_AGENT_INGEST_KEY",
        ...PROFILE_TEMPLATES["agent-runtime"],
      },
      {
        secretEnv: "ETLAYER_INGEST_KEY",
        ...PROFILE_TEMPLATES.legacy,
      },
    ],
  },
  {
    id: SECONDARY_PROJECT_ID,
    operatorSecretEnv: "ETLAYER_SECONDARY_REPLAY_KEY",
    destinations: ["posthog"],
    profiles: [
      {
        secretEnv: "ETLAYER_SECONDARY_BACKEND_INGEST_KEY",
        ...PROFILE_TEMPLATES.backend,
      },
    ],
  },
];

export function configuredProjects() {
  return PROJECTS.map((project) => ({
    ...project,
    destinations: [...project.destinations],
    profiles: project.profiles.map((profile) => ({
      ...profile,
      allowedAuthorityKinds: [...profile.allowedAuthorityKinds],
    })),
  }));
}

export function projectConfiguration(projectId) {
  const project = PROJECTS.find(({ id }) => id === projectId);
  return project || null;
}

export async function resolveProjectConfiguration(
  archive,
  projectId,
) {
  validateProjectId(projectId);

  const staticProject = projectConfiguration(projectId);
  if (staticProject) {
    return {
      source: "static",
      ...staticProject,
      destinations: [...staticProject.destinations],
      profiles: staticProject.profiles.map((profile) => ({
        ...profile,
        allowedAuthorityKinds: [
          ...profile.allowedAuthorityKinds,
        ],
      })),
    };
  }

  const dynamic = await readRegistryProject(
    archive,
    projectId,
  );

  if (!dynamic) return null;

  return {
    source: "registry",
    ...dynamic,
    destinations: [...(dynamic.destinations || [])],
  };
}

export function projectDestinations(projectId) {
  const project = projectConfiguration(projectId);

  if (!project) {
    throw new ProjectConfigurationError(
      `unknown static project: ${String(projectId)}`,
    );
  }

  return [...project.destinations];
}

export async function resolveProjectDestinations(
  archive,
  projectId,
) {
  const project = await resolveProjectConfiguration(
    archive,
    projectId,
  );

  if (!project || project.status === "disabled") {
    throw new ProjectConfigurationError(
      `unknown or inactive project: ${String(projectId)}`,
    );
  }

  return [...(project.destinations || [])];
}

export function operatorSecretEnv(projectId) {
  const project = projectConfiguration(projectId);

  if (!project) {
    return null;
  }

  return project.operatorSecretEnv;
}

export function profileTemplate(profileId) {
  const profile = PROFILE_TEMPLATES[profileId];
  if (!profile) {
    throw new ProjectConfigurationError(
      `unsupported producer profile: ${String(profileId)}`,
    );
  }

  return {
    ...profile,
    allowedAuthorityKinds: [
      ...profile.allowedAuthorityKinds,
    ],
  };
}

export function isSupportedDestination(destination) {
  return SUPPORTED_DESTINATIONS.includes(destination);
}

export function validateProjectId(projectId) {
  if (
    typeof projectId !== "string" ||
    projectId.trim() === "" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(projectId)
  ) {
    throw new ProjectConfigurationError(
      "project id must be a lowercase slug",
    );
  }

  return projectId;
}

export class ProjectConfigurationError extends Error {}

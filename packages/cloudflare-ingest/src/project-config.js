export const DEFAULT_PROJECT_ID = "etlayer-default";
export const SECONDARY_PROJECT_ID = "etlayer-secondary";

const PROJECTS = [
  {
    id: DEFAULT_PROJECT_ID,
    operatorSecretEnv: "ETLAYER_REPLAY_KEY",
    destinations: ["posthog", "statsig"],
    profiles: [
      {
        secretEnv: "ETLAYER_BROWSER_INGEST_KEY",
        profileId: "browser",
        producerKind: "browser",
        allowedAuthorityKinds: ["interaction"],
      },
      {
        secretEnv: "ETLAYER_BACKEND_INGEST_KEY",
        profileId: "backend",
        producerKind: "backend",
        allowedAuthorityKinds: ["business_state"],
      },
      {
        secretEnv: "ETLAYER_AGENT_INGEST_KEY",
        profileId: "agent-runtime",
        producerKind: "agent_runtime",
        allowedAuthorityKinds: ["agent_runtime"],
      },
      {
        secretEnv: "ETLAYER_INGEST_KEY",
        profileId: "legacy",
        producerKind: "legacy",
        allowedAuthorityKinds: [],
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
        profileId: "backend",
        producerKind: "backend",
        allowedAuthorityKinds: ["business_state"],
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

export function projectDestinations(projectId) {
  const project = projectConfiguration(projectId);

  if (!project) {
    throw new ProjectConfigurationError(
      `unknown project: ${String(projectId)}`,
    );
  }

  return [...project.destinations];
}

export function operatorSecretEnv(projectId) {
  const project = projectConfiguration(projectId);

  if (!project) {
    throw new ProjectConfigurationError(
      `unknown project: ${String(projectId)}`,
    );
  }

  return project.operatorSecretEnv;
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

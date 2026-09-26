import {
  buildCurrentGovernanceInventory,
} from "./governance-metrics.js";
import {
  ProjectConfigurationError,
  resolveProjectConfiguration,
  validateProjectId,
} from "./project-config.js";

export const PROJECT_READ_VERSION = 1;

export async function buildProjectReadModel(
  env,
  input,
  options = {},
) {
  const projectId =
    normalizeProjectId(
      input?.projectId,
    );

  if (
    !env?.ARCHIVE ||
    typeof env.ARCHIVE.get !== "function" ||
    typeof env.ARCHIVE.list !== "function"
  ) {
    throw new ProjectReadConfigurationError(
      "archive bucket is not configured for project reads",
    );
  }

  let project;

  try {
    project =
      await resolveProjectConfiguration(
        env.ARCHIVE,
        projectId,
      );
  } catch (error) {
    if (
      error instanceof
        ProjectConfigurationError
    ) {
      throw new ProjectReadNotFoundError(
        "project was not found",
      );
    }

    throw error;
  }

  if (!project) {
    throw new ProjectReadNotFoundError(
      "project was not found",
    );
  }

  const buildGovernance =
    options.buildCurrentGovernanceInventory ||
    buildCurrentGovernanceInventory;
  const governance =
    await buildGovernance(
      env.ARCHIVE,
      projectId,
      options,
    );

  return {
    version: PROJECT_READ_VERSION,
    project: {
      id: projectId,
      status:
        project.status || "active",
      source:
        project.source || "registry",
      createdAt:
        project.createdAt || null,
      updatedAt:
        project.updatedAt || null,
    },
    destinations: [
      ...new Set(
        project.destinations || [],
      ),
    ].sort(),
    governance,
    links:
      buildProjectLinks(
        input?.requestUrl,
        projectId,
      ),
  };
}

function buildProjectLinks(
  requestUrl,
  projectId,
) {
  let url;

  try {
    url = new URL(requestUrl);
  } catch {
    throw new ProjectReadValidationError(
      "requestUrl must be a valid URL",
    );
  }

  const encoded =
    encodeURIComponent(projectId);
  const base =
    url.origin;

  return {
    self:
      `${base}/api/v1/projects/${encoded}`,
    onboarding:
      `${base}/api/v1/projects/${encoded}/onboarding`,
    eventStatusTemplate:
      `${base}/api/v1/projects/${encoded}/events/{eventId}`,
    ingest:
      `${base}/v1/logs`,
  };
}

function normalizeProjectId(value) {
  try {
    return validateProjectId(value);
  } catch {
    throw new ProjectReadValidationError(
      "projectId must be a valid lowercase slug",
    );
  }
}

export class ProjectReadValidationError extends Error {}
export class ProjectReadNotFoundError extends Error {}
export class ProjectReadConfigurationError extends Error {}

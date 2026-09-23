import {
  DEFAULT_PROJECT_ID,
  validateProjectId,
} from "./project-config.js";

export function projectIdForEvent(event) {
  const projectId = event?.provenance?.projectId;

  if (typeof projectId === "string" && projectId.length > 0) {
    return validateProjectId(projectId);
  }

  // Historical pre-VS8 events belong to the original single-project namespace.
  return DEFAULT_PROJECT_ID;
}

export function projectPrefix(projectId) {
  return `projects/${encodeURIComponent(validateProjectId(projectId))}`;
}

export function scopedProjectKey(projectId, relativeKey) {
  validateRelativeKey(relativeKey);
  return `${projectPrefix(projectId)}/${relativeKey}`;
}

export function scopedEventKey(event, relativeKey) {
  return scopedProjectKey(projectIdForEvent(event), relativeKey);
}

export function requireProjectKey(projectId, key) {
  const prefix = `${projectPrefix(projectId)}/`;

  if (
    typeof key !== "string" ||
    !key.startsWith(prefix) ||
    key === prefix ||
    key.includes("..")
  ) {
    throw new ProjectScopeError(
      "key must reference evidence in the requested project",
    );
  }

  return key;
}

export function requireProjectSourceKey(projectId, sourceKey) {
  const key = requireProjectKey(projectId, sourceKey);
  const prefix = `${projectPrefix(projectId)}/events/`;

  if (!key.startsWith(prefix)) {
    throw new ProjectScopeError(
      "sourceKey must reference a canonical event in the requested project",
    );
  }

  return key;
}

function validateRelativeKey(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("..")
  ) {
    throw new ProjectScopeError(
      "relative project key is invalid",
    );
  }
}

export class ProjectScopeError extends Error {}

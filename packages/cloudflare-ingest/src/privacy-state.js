import { DEFAULT_PROJECT_ID } from "./project-config.js";
import { projectIdForEvent, scopedProjectKey } from "./project-scope.js";

export async function recordPrivacyState(
  archive,
  event,
  privacy,
  options = {},
) {
  if (!archive || typeof archive.put !== "function") {
    throw new PrivacyStateConfigurationError(
      "archive bucket is not configured for privacy state",
    );
  }

  validateEvent(event);
  validatePrivacy(privacy);

  const now =
    options.now instanceof Date
      ? options.now
      : new Date(options.now || Date.now());

  if (Number.isNaN(now.getTime())) {
    throw new PrivacyStateConfigurationError(
      "privacy state timestamp is invalid",
    );
  }

  const ingestActions = privacy.ingestActions || [];
  const deliveryActions = privacy.deliveryActions || [];
  const status =
    ingestActions.length > 0 || deliveryActions.length > 0
      ? "applied"
      : "clean";

  const projectId = projectIdForEvent(event);
  const state = {
    version: 2,
    projectId,
    eventId: event.id,
    eventName: event.eventName,
    policyVersion: privacy.policyVersion,
    status,
    sourceKey:
      typeof options.sourceKey === "string" &&
      options.sourceKey.length > 0
        ? options.sourceKey
        : null,
    ingestActions,
    deliveryActions,
    updatedAt: now.toISOString(),
  };

  const key = privacyStateKey(event.id, projectId);

  await archive.put(key, JSON.stringify(state), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    customMetadata: {
      project_id: projectId,
      event_id: event.id,
      event_name: event.eventName,
      policy_version: String(privacy.policyVersion),
      status,
      source_key: state.sourceKey || "",
      updated_at: state.updatedAt,
    },
  });

  return { key, state };
}

export async function readPrivacyState(
  archive,
  eventId,
  options = {},
) {
  if (!archive || typeof archive.get !== "function") return null;

  const key = privacyStateKey(
    eventId,
    options.projectId || DEFAULT_PROJECT_ID,
  );
  const object = await archive.get(key);
  if (!object) return null;

  const text =
    typeof object.text === "function"
      ? await object.text()
      : object.body != null
        ? await new Response(object.body).text()
        : null;

  if (text == null) {
    throw new PrivacyStateConfigurationError(
      `privacy state has no readable body: ${key}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new PrivacyStateConfigurationError(
      `privacy state is not valid JSON: ${key}`,
    );
  }
}

export function privacyStateKey(
  eventId,
  projectId = DEFAULT_PROJECT_ID,
) {
  if (typeof eventId !== "string" || eventId.trim() === "") {
    throw new PrivacyStateConfigurationError(
      "event id must be a non-empty string",
    );
  }

  return scopedProjectKey(
    projectId,
    `privacy/${encodeURIComponent(eventId)}.json`,
  );
}

function validateEvent(event) {
  if (
    !event ||
    typeof event.id !== "string" ||
    event.id.trim() === "" ||
    typeof event.eventName !== "string" ||
    event.eventName.trim() === ""
  ) {
    throw new PrivacyStateConfigurationError(
      "managed event id and eventName are required",
    );
  }
}

function validatePrivacy(privacy) {
  if (
    !privacy ||
    !Number.isSafeInteger(privacy.policyVersion) ||
    privacy.policyVersion < 1
  ) {
    throw new PrivacyStateConfigurationError(
      "privacy result must include a positive policyVersion",
    );
  }
}

export class PrivacyStateConfigurationError extends Error {}

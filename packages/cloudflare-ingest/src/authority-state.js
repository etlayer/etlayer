import { DEFAULT_PROJECT_ID } from "./project-config.js";
import { projectIdForEvent, scopedProjectKey } from "./project-scope.js";

export async function recordAuthorityState(
  archive,
  event,
  authority,
  options = {},
) {
  if (!archive || typeof archive.put !== "function") {
    throw new AuthorityStateConfigurationError(
      "archive bucket is not configured for authority state",
    );
  }

  validateEvent(event);
  validateAuthority(authority);

  const now =
    options.now instanceof Date
      ? options.now
      : new Date(options.now || Date.now());

  if (Number.isNaN(now.getTime())) {
    throw new AuthorityStateConfigurationError(
      "authority state timestamp is invalid",
    );
  }

  const projectId = projectIdForEvent(event);
  const state = {
    version: 2,
    projectId,
    eventId: event.id,
    eventName: event.eventName,
    status: authority.status,
    policyVersion: authority.policyVersion,
    profileId: authority.profileId,
    trustedProducerKind: authority.trustedProducerKind,
    claim: authority.claim,
    errors: authority.errors,
    sourceKey:
      typeof options.sourceKey === "string" &&
      options.sourceKey.length > 0
        ? options.sourceKey
        : null,
    updatedAt: now.toISOString(),
  };

  const key = authorityStateKey(event.id, projectId);

  await archive.put(key, JSON.stringify(state), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    customMetadata: {
      project_id: projectId,
      event_id: event.id,
      event_name: event.eventName,
      status: authority.status,
      policy_version: String(authority.policyVersion),
      profile_id: authority.profileId || "",
      trusted_producer_kind:
        authority.trustedProducerKind || "",
      source_key: state.sourceKey || "",
      updated_at: state.updatedAt,
    },
  });

  return { key, state };
}

export async function readAuthorityState(
  archive,
  eventId,
  options = {},
) {
  if (!archive || typeof archive.get !== "function") return null;

  const key = authorityStateKey(
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
    throw new AuthorityStateConfigurationError(
      `authority state has no readable body: ${key}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AuthorityStateConfigurationError(
      `authority state is not valid JSON: ${key}`,
    );
  }
}

export function authorityStateKey(
  eventId,
  projectId = DEFAULT_PROJECT_ID,
) {
  if (typeof eventId !== "string" || eventId.trim() === "") {
    throw new AuthorityStateConfigurationError(
      "event id must be a non-empty string",
    );
  }

  return scopedProjectKey(
    projectId,
    `authority/${encodeURIComponent(eventId)}.json`,
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
    throw new AuthorityStateConfigurationError(
      "managed event id and eventName are required",
    );
  }
}

function validateAuthority(authority) {
  if (
    !authority ||
    !Number.isSafeInteger(authority.policyVersion) ||
    authority.policyVersion < 1 ||
    !["allowed", "blocked", "not_applicable"].includes(
      authority.status,
    ) ||
    !Array.isArray(authority.errors)
  ) {
    throw new AuthorityStateConfigurationError(
      "authority result is invalid",
    );
  }
}

export class AuthorityStateConfigurationError extends Error {}

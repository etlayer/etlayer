export async function recordIdentityState(
  archive,
  event,
  identity,
  options = {},
) {
  if (!archive || typeof archive.put !== "function") {
    throw new IdentityStateConfigurationError(
      "archive bucket is not configured for identity state",
    );
  }

  validateEvent(event);
  validateIdentity(identity);

  const now =
    options.now instanceof Date
      ? options.now
      : new Date(options.now || Date.now());

  if (Number.isNaN(now.getTime())) {
    throw new IdentityStateConfigurationError(
      "identity state timestamp is invalid",
    );
  }

  const state = {
    version: 2,
    eventId: event.id,
    eventName: event.eventName,
    status: identity.status,
    subject: identity.subject,
    actor: identity.actor,
    delegation: identity.delegation,
    anonymousId: identity.anonymousId,
    userId: identity.userId,
    accountId: identity.accountId,
    sessionId: identity.sessionId,
    transition: identity.transition,
    agent: identity.agent,
    attribution: identity.attribution,
    sourceKey:
      typeof options.sourceKey === "string" &&
      options.sourceKey.length > 0
        ? options.sourceKey
        : null,
    updatedAt: now.toISOString(),
  };

  const key = identityStateKey(event.id);

  await archive.put(key, JSON.stringify(state), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    customMetadata: {
      event_id: event.id,
      event_name: event.eventName,
      status: identity.status,
      subject_kind: identity.subject.kind,
      actor_type: identity.actor?.type || "",
      source_key: state.sourceKey || "",
      updated_at: state.updatedAt,
    },
  });

  return { key, state };
}

export async function readIdentityState(archive, eventId) {
  if (!archive || typeof archive.get !== "function") return null;

  const key = identityStateKey(eventId);
  const object = await archive.get(key);
  if (!object) return null;

  const text =
    typeof object.text === "function"
      ? await object.text()
      : object.body != null
        ? await new Response(object.body).text()
        : null;

  if (text == null) {
    throw new IdentityStateConfigurationError(
      `identity state has no readable body: ${key}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new IdentityStateConfigurationError(
      `identity state is not valid JSON: ${key}`,
    );
  }
}

export function identityStateKey(eventId) {
  if (typeof eventId !== "string" || eventId.trim() === "") {
    throw new IdentityStateConfigurationError(
      "event id must be a non-empty string",
    );
  }

  return `identity/${encodeURIComponent(eventId)}.json`;
}

function validateEvent(event) {
  if (
    !event ||
    typeof event.id !== "string" ||
    event.id.trim() === "" ||
    typeof event.eventName !== "string" ||
    event.eventName.trim() === ""
  ) {
    throw new IdentityStateConfigurationError(
      "managed event id and eventName are required",
    );
  }
}

function validateIdentity(identity) {
  if (
    !identity ||
    !["resolved", "fallback"].includes(identity.status) ||
    !identity.subject ||
    typeof identity.subject.id !== "string" ||
    typeof identity.subject.kind !== "string" ||
    !Array.isArray(identity.delegation)
  ) {
    throw new IdentityStateConfigurationError(
      "identity result is invalid",
    );
  }
}

export class IdentityStateConfigurationError extends Error {}

export async function recordValidationState(
  archive,
  event,
  validation,
  options = {},
) {
  if (!archive || typeof archive.put !== "function") {
    throw new ValidationStateConfigurationError(
      "archive bucket is not configured for validation state",
    );
  }

  validateEvent(event);
  validateResult(validation);

  const now =
    options.now instanceof Date
      ? options.now
      : new Date(options.now || Date.now());

  if (Number.isNaN(now.getTime())) {
    throw new ValidationStateConfigurationError(
      "validation state timestamp is invalid",
    );
  }

  const state = {
    version: 1,
    eventId: event.id,
    eventName: event.eventName,
    schemaVersion: validation.schemaVersion,
    status: validation.status,
    contractId: validation.contractId,
    errors: validation.errors || [],
    sourceKey:
      typeof options.sourceKey === "string" && options.sourceKey.length > 0
        ? options.sourceKey
        : null,
    updatedAt: now.toISOString(),
  };

  const key = validationStateKey(event.id);

  await archive.put(key, JSON.stringify(state), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    customMetadata: {
      event_id: event.id,
      event_name: event.eventName,
      status: validation.status,
      schema_version:
        validation.schemaVersion == null
          ? ""
          : String(validation.schemaVersion),
      contract_id: validation.contractId || "",
      source_key: state.sourceKey || "",
      updated_at: state.updatedAt,
    },
  });

  return { key, state };
}

export async function readValidationState(archive, eventId) {
  if (!archive || typeof archive.get !== "function") return null;

  const key = validationStateKey(eventId);
  const object = await archive.get(key);
  if (!object) return null;

  let text;
  if (typeof object.text === "function") {
    text = await object.text();
  } else if (object.body != null) {
    text = await new Response(object.body).text();
  } else {
    throw new ValidationStateConfigurationError(
      `validation state has no readable body: ${key}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationStateConfigurationError(
      `validation state is not valid JSON: ${key}`,
    );
  }
}

export function validationStateKey(eventId) {
  if (typeof eventId !== "string" || eventId.trim() === "") {
    throw new ValidationStateConfigurationError(
      "event id must be a non-empty string",
    );
  }

  return `validation/${encodeURIComponent(eventId)}.json`;
}

function validateEvent(event) {
  if (
    !event ||
    typeof event.id !== "string" ||
    event.id.trim() === "" ||
    typeof event.eventName !== "string" ||
    event.eventName.trim() === ""
  ) {
    throw new ValidationStateConfigurationError(
      "managed event id and eventName are required",
    );
  }
}

function validateResult(validation) {
  if (
    !validation ||
    !["valid", "blocked", "unmanaged"].includes(validation.status)
  ) {
    throw new ValidationStateConfigurationError(
      "validation result has an unsupported status",
    );
  }
}

export class ValidationStateConfigurationError extends Error {}

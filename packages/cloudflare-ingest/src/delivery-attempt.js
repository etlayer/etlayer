import {
  DEFAULT_PROJECT_ID,
} from "./project-config.js";
import {
  projectIdForEvent,
  scopedProjectKey,
} from "./project-scope.js";

export const DELIVERY_ATTEMPT_VERSION = 1;

export async function recordDeliveryAttempt(
  archive,
  event,
  destination,
  result,
  options = {},
) {
  if (!archive || typeof archive.put !== "function") {
    throw new DeliveryAttemptConfigurationError(
      "archive bucket is not configured for delivery attempts",
    );
  }

  validateEvent(event);
  validateDestination(destination);

  const projectId = projectIdForEvent(event);
  const attemptNumber = normalizeAttemptNumber(
    options.attemptNumber,
  );
  const startedAt = normalizeDate(
    options.startedAt || options.now,
    "delivery attempt startedAt",
  );
  const completedAt = normalizeDate(
    options.completedAt || options.now,
    "delivery attempt completedAt",
  );

  if (
    startedAt.getTime() >
    completedAt.getTime()
  ) {
    throw new DeliveryAttemptConfigurationError(
      "delivery attempt startedAt must not be after completedAt",
    );
  }

  const attemptId =
    normalizeAttemptId(options.attemptId) ||
    options.crypto?.randomUUID?.() ||
    globalThis.crypto?.randomUUID?.();

  if (!attemptId) {
    throw new DeliveryAttemptConfigurationError(
      "delivery attempt id could not be generated",
    );
  }

  const deliveryId = deliveryResourceId(
    event.id,
    destination,
    projectId,
  );

  const state = {
    version: DELIVERY_ATTEMPT_VERSION,
    projectId,
    deliveryId,
    attemptId,
    attemptNumber,
    eventId: event.id,
    eventName: event.eventName,
    destination,
    mode:
      options.delivery?.mode || "live",
    status: normalizeStatus(result?.status),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  };

  if (options.delivery?.replayId) {
    state.replayId =
      options.delivery.replayId;
  }

  if (
    typeof result?.reason === "string" &&
    result.reason.length > 0
  ) {
    state.reason = result.reason;
  }

  if (
    typeof result?.uuid === "string" &&
    result.uuid.length > 0
  ) {
    state.destinationEventId = result.uuid;
  }

  if (result?.error) {
    state.error = serializeError(result.error);
  }

  const key = deliveryAttemptKey(
    destination,
    event.id,
    attemptId,
    projectId,
  );

  const stored = await archive.put(
    key,
    JSON.stringify(state),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType:
          "application/json; charset=utf-8",
      },
      customMetadata: {
        project_id: projectId,
        delivery_id: deliveryId,
        attempt_id: attemptId,
        attempt_number: String(attemptNumber),
        event_id: event.id,
        event_name: event.eventName,
        destination,
        mode: state.mode,
        status: state.status,
        completed_at: state.completedAt,
      },
    },
  );

  if (stored === null) {
    throw new DeliveryAttemptConflictError(
      `delivery attempt already exists: ${key}`,
    );
  }

  return { key, state };
}

export async function listDeliveryAttempts(
  archive,
  eventId,
  destination,
  options = {},
) {
  if (
    !archive ||
    typeof archive.list !== "function" ||
    typeof archive.get !== "function"
  ) {
    return [];
  }

  const projectId =
    options.projectId || DEFAULT_PROJECT_ID;
  const prefix = deliveryAttemptPrefix(
    destination,
    eventId,
    projectId,
  );
  const attempts = [];
  let cursor;

  do {
    const page = await archive.list({
      prefix,
      cursor,
      limit: 1000,
    });

    for (const object of page.objects || []) {
      const stored = await archive.get(object.key);
      if (!stored) continue;

      const text =
        typeof stored.text === "function"
          ? await stored.text()
          : stored.body != null
            ? await new Response(stored.body).text()
            : null;

      if (text == null) {
        throw new DeliveryAttemptConfigurationError(
          `delivery attempt has no readable body: ${object.key}`,
        );
      }

      attempts.push(JSON.parse(text));
    }

    cursor =
      page.truncated && page.cursor
        ? page.cursor
        : undefined;
  } while (cursor);

  attempts.sort((left, right) => {
    const number =
      (left.attemptNumber || 0) -
      (right.attemptNumber || 0);

    if (number !== 0) return number;

    return String(left.completedAt || "")
      .localeCompare(
        String(right.completedAt || ""),
      );
  });

  return attempts;
}

export function deliveryResourceId(
  eventId,
  destination,
  projectId = DEFAULT_PROJECT_ID,
) {
  validateIdentifier(projectId, "project id");
  validateIdentifier(eventId, "event id");
  validateDestination(destination);

  return [
    "delivery",
    encodeURIComponent(projectId),
    encodeURIComponent(destination),
    encodeURIComponent(eventId),
  ].join(":");
}

export function deliveryAttemptKey(
  destination,
  eventId,
  attemptId,
  projectId = DEFAULT_PROJECT_ID,
) {
  validateDestination(destination);
  validateIdentifier(eventId, "event id");
  validateIdentifier(attemptId, "attempt id");

  return scopedProjectKey(
    projectId,
    [
      "delivery-attempts",
      encodeURIComponent(destination),
      encodeURIComponent(eventId),
      encodeURIComponent(attemptId) + ".json",
    ].join("/"),
  );
}

function deliveryAttemptPrefix(
  destination,
  eventId,
  projectId,
) {
  return scopedProjectKey(
    projectId,
    [
      "delivery-attempts",
      encodeURIComponent(destination),
      encodeURIComponent(eventId),
      "",
    ].join("/"),
  );
}

export function nextAttemptNumber(previous) {
  if (!previous) return 1;

  if (
    Number.isSafeInteger(previous.attemptCount) &&
    previous.attemptCount >= 1
  ) {
    return previous.attemptCount + 1;
  }

  return 2;
}

function normalizeAttemptNumber(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new DeliveryAttemptConfigurationError(
      "delivery attempt number must be a positive integer",
    );
  }

  return value;
}

function normalizeAttemptId(value) {
  if (value == null) return null;

  validateIdentifier(value, "attempt id");
  return value;
}

function normalizeDate(value, label) {
  const date =
    value instanceof Date
      ? value
      : new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new DeliveryAttemptConfigurationError(
      `${label} is invalid`,
    );
  }

  return date;
}

function normalizeStatus(status) {
  if (
    status === "exported" ||
    status === "skipped" ||
    status === "failed"
  ) {
    return status;
  }

  throw new DeliveryAttemptConfigurationError(
    `unsupported delivery attempt status: ${String(status)}`,
  );
}

function serializeError(error) {
  if (error instanceof Error) {
    const result = {
      name: error.name,
      message: error.message,
    };

    if (Number.isInteger(error.status)) {
      result.status = error.status;
    }

    return result;
  }

  return {
    name: "Error",
    message: String(error),
  };
}

function validateEvent(event) {
  if (
    !event ||
    typeof event.id !== "string" ||
    event.id.trim() === "" ||
    typeof event.eventName !== "string" ||
    event.eventName.trim() === ""
  ) {
    throw new DeliveryAttemptConfigurationError(
      "managed event id and eventName are required",
    );
  }
}

function validateDestination(destination) {
  validateIdentifier(
    destination,
    "destination",
  );
}

function validateIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new DeliveryAttemptConfigurationError(
      `${label} must be a non-empty string`,
    );
  }
}

export class DeliveryAttemptConfigurationError extends Error {}
export class DeliveryAttemptConflictError extends Error {}

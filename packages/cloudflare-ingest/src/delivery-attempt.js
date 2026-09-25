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

  if (startedAt.getTime() > completedAt.getTime()) {
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
    mode: options.delivery?.mode || "live",
    status: normalizeStatus(result?.status),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  };

  if (options.delivery?.replayId) {
    state.replayId = options.delivery.replayId;
  }

  if (options.delivery?.sourceKey) {
    state.sourceKey = options.delivery.sourceKey;
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
    attemptNumber,
    attemptId,
    projectId,
  );

  const stored = await archive.put(
    key,
    JSON.stringify(state),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
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

export async function nextDeliveryAttemptNumber(
  archive,
  eventId,
  destination,
  options = {},
) {
  validateIdentifier(eventId, "event id");
  validateDestination(destination);

  const projectId =
    options.projectId || DEFAULT_PROJECT_ID;
  let highest =
    historicalAttemptCount(options.previousState);

  if (archive && typeof archive.list === "function") {
    const prefix = deliveryAttemptPrefix(
      destination,
      eventId,
      projectId,
    );
    let cursor;

    do {
      const page = await archive.list({
        prefix,
        cursor,
        limit: 1000,
      });

      for (const object of page.objects || []) {
        highest = Math.max(
          highest,
          attemptNumberFromKey(
            object.key,
            prefix,
          ),
        );
      }

      cursor =
        page.truncated && page.cursor
          ? page.cursor
          : undefined;
    } while (cursor);
  }

  return highest + 1;
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

  validateIdentifier(eventId, "event id");
  validateDestination(destination);

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

      let state;
      try {
        state = JSON.parse(text);
      } catch {
        throw new DeliveryAttemptConfigurationError(
          `delivery attempt is not valid JSON: ${object.key}`,
        );
      }

      validateStoredAttempt(
        state,
        projectId,
        eventId,
        destination,
        object.key,
      );
      attempts.push(state);
    }

    cursor =
      page.truncated && page.cursor
        ? page.cursor
        : undefined;
  } while (cursor);

  attempts.sort((left, right) => {
    const number =
      left.attemptNumber - right.attemptNumber;

    if (number !== 0) return number;

    return left.attemptId.localeCompare(
      right.attemptId,
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
  attemptNumber,
  attemptId,
  projectId = DEFAULT_PROJECT_ID,
) {
  validateDestination(destination);
  validateIdentifier(eventId, "event id");
  normalizeAttemptNumber(attemptNumber);
  validateIdentifier(attemptId, "attempt id");

  return (
    deliveryAttemptPrefix(
      destination,
      eventId,
      projectId,
    ) +
    String(attemptNumber).padStart(6, "0") +
    "--" +
    encodeURIComponent(attemptId) +
    ".json"
  );
}

export function deliveryAttemptPrefix(
  destination,
  eventId,
  projectId = DEFAULT_PROJECT_ID,
) {
  validateDestination(destination);
  validateIdentifier(eventId, "event id");

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

export function historicalAttemptCount(previous) {
  if (!previous) return 0;

  if (
    Number.isSafeInteger(previous.attemptCount) &&
    previous.attemptCount >= 0
  ) {
    return previous.attemptCount;
  }

  return 1;
}

function attemptNumberFromKey(key, prefix) {
  if (
    typeof key !== "string" ||
    !key.startsWith(prefix)
  ) {
    return 0;
  }

  const basename = key.slice(prefix.length);
  const match = basename.match(/^(\d+)--/);
  if (!match) return 0;

  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? parsed
    : 0;
}

function validateStoredAttempt(
  state,
  projectId,
  eventId,
  destination,
  key,
) {
  if (
    !state ||
    state.version !== DELIVERY_ATTEMPT_VERSION ||
    state.projectId !== projectId ||
    state.eventId !== eventId ||
    state.destination !== destination ||
    typeof state.attemptId !== "string" ||
    !Number.isSafeInteger(state.attemptNumber) ||
    state.attemptNumber < 1 ||
    typeof state.status !== "string"
  ) {
    throw new DeliveryAttemptConfigurationError(
      `delivery attempt does not match requested delivery: ${key}`,
    );
  }
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

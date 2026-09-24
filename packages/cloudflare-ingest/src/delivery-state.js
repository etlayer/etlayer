import { DEFAULT_PROJECT_ID } from "./project-config.js";
import { projectIdForEvent, scopedProjectKey } from "./project-scope.js";
import { deliveryResourceId } from "./delivery-attempt.js";

export async function readDeliveryState(
  archive,
  eventId,
  destination,
  options = {},
) {
  if (!archive || typeof archive.get !== "function") {
    return null;
  }

  const key = deliveryStateKey(
    destination,
    eventId,
    options.projectId || DEFAULT_PROJECT_ID,
  );
  const object = await archive.get(key);
  if (!object) return null;

  let text;
  if (typeof object.text === "function") {
    text = await object.text();
  } else if (object.body != null) {
    text = await new Response(object.body).text();
  } else {
    throw new DeliveryStateConfigurationError(
      `delivery state has no readable body: ${key}`,
    );
  }

  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw new DeliveryStateConfigurationError(
      `delivery state is not valid JSON: ${key}`,
    );
  }

  if (
    !state ||
    state.eventId !== eventId ||
    state.destination !== destination ||
    typeof state.status !== "string"
  ) {
    throw new DeliveryStateConfigurationError(
      `delivery state does not match requested event/destination: ${key}`,
    );
  }

  return state;
}

export async function recordDeliveryState(
  archive,
  event,
  destination,
  result,
  options = {},
) {
  if (!archive || typeof archive.put !== "function") {
    throw new DeliveryStateConfigurationError(
      "archive bucket is not configured for delivery state",
    );
  }

  validateEvent(event);
  validateDestination(destination);

  const now =
    options.now instanceof Date
      ? options.now
      : new Date(options.now || Date.now());

  if (Number.isNaN(now.getTime())) {
    throw new DeliveryStateConfigurationError(
      "delivery state timestamp is invalid",
    );
  }

  const projectId = projectIdForEvent(event);
  const state = {
    version: 3,
    projectId,
    deliveryId: deliveryResourceId(
      event.id,
      destination,
      projectId,
    ),
    eventId: event.id,
    eventName: event.eventName,
    destination,
    status: normalizeStatus(result?.status),
    updatedAt: now.toISOString(),
  };

  if (typeof result?.reason === "string" && result.reason.length > 0) {
    state.reason = result.reason;
  }

  if (typeof result?.uuid === "string" && result.uuid.length > 0) {
    state.destinationEventId = result.uuid;
  }

  if (result?.error) {
    state.error = serializeError(result.error);
  }

  if (options.attempt) {
    state.attemptCount =
      options.attempt.attemptNumber;
    state.latestAttemptId =
      options.attempt.attemptId;
    state.lastAttemptAt =
      options.attempt.completedAt;
  }

  if (options.delivery?.mode) {
    state.deliveryMode = options.delivery.mode;
  }

  if (options.delivery?.replayId) {
    state.replayId = options.delivery.replayId;
  }

  const key = deliveryStateKey(
    destination,
    event.id,
    projectId,
  );

  await archive.put(key, JSON.stringify(state), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    customMetadata: {
      project_id: projectId,
      event_id: event.id,
      event_name: event.eventName,
      destination,
      status: state.status,
      updated_at: state.updatedAt,
    },
  });

  return { key, state };
}

export function deliveryStateKey(
  destination,
  eventId,
  projectId = DEFAULT_PROJECT_ID,
) {
  validateDestination(destination);

  if (typeof eventId !== "string" || eventId.trim() === "") {
    throw new DeliveryStateConfigurationError(
      "event id must be a non-empty string",
    );
  }

  return scopedProjectKey(
    projectId,
    `deliveries/${encodeURIComponent(destination)}/${encodeURIComponent(eventId)}.json`,
  );
}

function normalizeStatus(status) {
  if (status === "exported" || status === "skipped" || status === "failed") {
    return status;
  }

  throw new DeliveryStateConfigurationError(
    `unsupported delivery status: ${String(status)}`,
  );
}

function serializeError(error) {
  if (error instanceof Error) {
    const serialized = {
      name: error.name,
      message: error.message,
    };

    if (Number.isInteger(error.status)) {
      serialized.status = error.status;
    }

    return serialized;
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
    throw new DeliveryStateConfigurationError(
      "managed event id and eventName are required",
    );
  }
}

function validateDestination(destination) {
  if (typeof destination !== "string" || destination.trim() === "") {
    throw new DeliveryStateConfigurationError(
      "destination must be a non-empty string",
    );
  }
}

export class DeliveryStateConfigurationError extends Error {}

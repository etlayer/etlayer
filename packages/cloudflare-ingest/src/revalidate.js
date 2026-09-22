import { processPersistedEvent } from "./processing.js";

export async function revalidateArchivedEvent(
  env,
  input,
  options = {},
) {
  if (!env.ARCHIVE || typeof env.ARCHIVE.get !== "function") {
    throw new RevalidationConfigurationError(
      "archive bucket is not configured for revalidation",
    );
  }

  const sourceKey = normalizeSourceKey(input?.sourceKey);
  const object = await env.ARCHIVE.get(sourceKey);

  if (!object) {
    throw new RevalidationNotFoundError(
      `canonical event not found: ${sourceKey}`,
    );
  }

  const event = await readArchivedEvent(object, sourceKey);
  const process = options.process || processPersistedEvent;

  const result = await process(
    event,
    env,
    {
      sourceKey,
      now: options.now,
      validate: options.validate,
      validation: options.validation,
      recordValidationState: options.recordValidationState,
      route: options.route,
      routing: options.routing,
    },
  );

  return {
    sourceKey,
    eventId: event.id,
    eventName: event.eventName,
    validation: result.validation,
    authority: result.authority || null,
    identity: result.identity || null,
    deliveries: result.deliveries.map((delivery) => ({
      destination: delivery.destination,
      status: delivery.status,
      ...(delivery.reason ? { reason: delivery.reason } : {}),
    })),
  };
}

function normalizeSourceKey(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("events/") ||
    value.includes("..")
  ) {
    throw new RevalidationValidationError(
      "sourceKey must reference a canonical events/ object",
    );
  }

  return value;
}

async function readArchivedEvent(object, sourceKey) {
  let text;

  if (typeof object.text === "function") {
    text = await object.text();
  } else if (object.body != null) {
    text = await new Response(object.body).text();
  } else {
    throw new RevalidationArchiveError(
      `canonical event has no readable body: ${sourceKey}`,
    );
  }

  let event;
  try {
    event = JSON.parse(text);
  } catch {
    throw new RevalidationArchiveError(
      `canonical event is not valid JSON: ${sourceKey}`,
    );
  }

  if (
    !event ||
    typeof event.id !== "string" ||
    typeof event.eventName !== "string" ||
    typeof event.receivedAt !== "string"
  ) {
    throw new RevalidationArchiveError(
      `canonical object is not a managed ETLayer event: ${sourceKey}`,
    );
  }

  return event;
}

export class RevalidationValidationError extends Error {}
export class RevalidationConfigurationError extends Error {}
export class RevalidationNotFoundError extends Error {}
export class RevalidationArchiveError extends Error {}

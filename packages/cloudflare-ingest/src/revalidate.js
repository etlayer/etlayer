import { processPersistedEvent } from "./processing.js";
import { validateProjectId } from "./project-config.js";
import { projectIdForEvent, requireProjectSourceKey } from "./project-scope.js";

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

  const projectId = normalizeProjectId(input?.projectId);
  const sourceKey = normalizeSourceKey(
    projectId,
    input?.sourceKey,
  );
  const object = await env.ARCHIVE.get(sourceKey);

  if (!object) {
    throw new RevalidationNotFoundError(
      `canonical event not found: ${sourceKey}`,
    );
  }

  const event = await readArchivedEvent(object, sourceKey);

  if (projectIdForEvent(event) !== projectId) {
    throw new RevalidationArchiveError(
      `canonical event project does not match requested project: ${sourceKey}`,
    );
  }

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
      evaluateAuthority: options.evaluateAuthority,
      authority: options.authority,
      recordAuthorityState: options.recordAuthorityState,
      applyDeliveryPrivacy: options.applyDeliveryPrivacy,
      privacy: options.privacy,
      recordPrivacyState: options.recordPrivacyState,
      resolveIdentity: options.resolveIdentity,
      identity: options.identity,
      recordIdentityState: options.recordIdentityState,
      recordDecisionHistory: options.recordDecisionHistory,
      decisionId: options.decisionId,
      evaluationKind: "revalidation",
      route: options.route,
      routing: {
        ...(options.routing || {}),
        delivery: {
          ...(options.routing?.delivery || {}),
          mode: "revalidation",
          sourceKey,
        },
      },
    },
  );

  return {
    projectId,
    sourceKey,
    eventId: event.id,
    eventName: event.eventName,
    validation: result.validation,
    authority: result.authority || null,
    identity: result.identity || null,
    decision: result.decision || null,
    deliveries: result.deliveries.map((delivery) => ({
      destination: delivery.destination,
      status: delivery.status,
      ...(delivery.reason ? { reason: delivery.reason } : {}),
    })),
  };
}

function normalizeProjectId(value) {
  try {
    return validateProjectId(value);
  } catch {
    throw new RevalidationValidationError(
      "projectId must be a valid project slug",
    );
  }
}

function normalizeSourceKey(projectId, value) {
  try {
    return requireProjectSourceKey(projectId, value);
  } catch {
    throw new RevalidationValidationError(
      "sourceKey must reference a canonical event in the requested project",
    );
  }
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

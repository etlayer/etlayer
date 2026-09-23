import { readAuthorityState } from "./authority-state.js";
import {
  readDecisionHistory,
  readLatestDecisionPointer,
} from "./decision-history.js";
import { readDeliveryState } from "./delivery-state.js";
import { readIdentityState } from "./identity-state.js";
import { authenticateProjectOperator } from "./operator-auth.js";
import { readPrivacyState } from "./privacy-state.js";
import {
  resolveProjectDestinations,
  validateProjectId,
} from "./project-config.js";
import { readValidationState } from "./validation-state.js";

export async function handleEventInspect(
  request,
  env,
  options = {},
) {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return jsonResponse(
      { error: "content-type must be application/json" },
      415,
    );
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse(
      { error: "request body is not valid JSON" },
      400,
    );
  }

  let projectId;
  try {
    projectId = validateProjectId(input?.projectId);
  } catch {
    return jsonResponse(
      { error: "projectId must be a valid project slug" },
      400,
    );
  }

  const eventId = input?.eventId;
  if (
    typeof eventId !== "string" ||
    eventId.trim() === ""
  ) {
    return jsonResponse(
      { error: "eventId is required" },
      400,
    );
  }

  const authenticate =
    options.authenticateProjectOperator ||
    authenticateProjectOperator;
  const authentication = await authenticate(
    request,
    env,
    projectId,
    { crypto: options.crypto },
  );

  if (!authentication.ok) {
    if (
      authentication.reason ===
      "operator_credential_not_configured"
    ) {
      return jsonResponse(
        {
          error:
            "operator credential is not configured for project",
        },
        503,
      );
    }

    if (authentication.reason === "unknown_project") {
      return jsonResponse(
        { error: "unknown project" },
        404,
      );
    }

    return jsonResponse(
      {
        error:
          "invalid operator credential for project",
      },
      401,
    );
  }

  if (!env.ARCHIVE || typeof env.ARCHIVE.get !== "function") {
    return jsonResponse(
      { error: "archive bucket is not configured" },
      503,
    );
  }

  let destinations;
  try {
    destinations = await resolveProjectDestinations(
      env.ARCHIVE,
      projectId,
    );
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "project configuration unavailable",
      },
      404,
    );
  }

  const [
    validation,
    authority,
    privacy,
    identity,
    pointer,
  ] = await Promise.all([
    readValidationState(
      env.ARCHIVE,
      eventId,
      { projectId },
    ),
    readAuthorityState(
      env.ARCHIVE,
      eventId,
      { projectId },
    ),
    readPrivacyState(
      env.ARCHIVE,
      eventId,
      { projectId },
    ),
    readIdentityState(
      env.ARCHIVE,
      eventId,
      { projectId },
    ),
    readLatestDecisionPointer(
      env.ARCHIVE,
      eventId,
      { projectId },
    ),
  ]);

  const decision = pointer
    ? await readDecisionHistory(
        env.ARCHIVE,
        eventId,
        pointer.decisionId,
        { projectId },
      )
    : null;

  const deliveryStates = await Promise.all(
    destinations.map(async (destination) => ({
      destination,
      state: await readDeliveryState(
        env.ARCHIVE,
        eventId,
        destination,
        { projectId },
      ),
    })),
  );

  const known = Boolean(
    validation ||
      authority ||
      privacy ||
      identity ||
      decision ||
      deliveryStates.some(({ state }) => state),
  );

  const routeEligible =
    typeof decision?.routeEligible === "boolean"
      ? decision.routeEligible
      : null;

  const deliveries = deliveryStates.map(
    ({ destination, state }) => ({
      destination,
      status:
        state?.status ||
        (routeEligible === false
          ? "not_routed"
          : "pending"),
      state,
    }),
  );

  const deliveryComplete =
    routeEligible === false ||
    deliveries.length === 0 ||
    deliveries.every(({ state }) => state != null);

  const status = !known
    ? "pending_or_unknown"
    : !decision || !deliveryComplete
      ? "processing"
      : "complete";

  const sourceKey =
    decision?.sourceKey ||
    authority?.sourceKey ||
    validation?.sourceKey ||
    privacy?.sourceKey ||
    identity?.sourceKey ||
    null;

  return jsonResponse(
    {
      version: 1,
      projectId,
      eventId,
      status,
      known,
      sourceKey,
      validation,
      authority,
      privacy,
      identity,
      decision,
      deliveries,
    },
    200,
  );
}

function isJsonContentType(contentType) {
  if (!contentType) return false;
  return (
    contentType.split(";", 1)[0].trim().toLowerCase() ===
    "application/json"
  );
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type":
        "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

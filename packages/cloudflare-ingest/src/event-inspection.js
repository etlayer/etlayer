import { readAuthorityState } from "./authority-state.js";
import {
  readDecisionHistory,
  readLatestDecisionPointer,
} from "./decision-history.js";
import { readDeliveryState } from "./delivery-state.js";
import { listDeliveryAttempts } from "./delivery-attempt.js";
import { readIdentityState } from "./identity-state.js";
import { readPrivacyState } from "./privacy-state.js";
import { resolveProjectDestinations } from "./project-config.js";
import { readValidationState } from "./validation-state.js";
import {
  readContractOwnership,
} from "./contract-ownership.js";

export async function inspectEventState(
  archive,
  projectId,
  eventId,
) {
  if (!archive || typeof archive.get !== "function") {
    throw new EventInspectionConfigurationError(
      "archive bucket is not configured",
    );
  }

  const destinations = await resolveProjectDestinations(
    archive,
    projectId,
  );

  const [
    validation,
    authority,
    privacy,
    identity,
    pointer,
  ] = await Promise.all([
    readValidationState(
      archive,
      eventId,
      { projectId },
    ),
    readAuthorityState(
      archive,
      eventId,
      { projectId },
    ),
    readPrivacyState(
      archive,
      eventId,
      { projectId },
    ),
    readIdentityState(
      archive,
      eventId,
      { projectId },
    ),
    readLatestDecisionPointer(
      archive,
      eventId,
      { projectId },
    ),
  ]);

  const decision = pointer
    ? await readDecisionHistory(
        archive,
        eventId,
        pointer.decisionId,
        { projectId },
      )
    : null;

  const ownership =
    validation?.eventName
      ? await readContractOwnership(
          archive,
          projectId,
          validation.eventName,
        )
      : null;

  const deliveryStates = await Promise.all(
    destinations.map(async (destination) => {
      const [state, attempts] = await Promise.all([
        readDeliveryState(
          archive,
          eventId,
          destination,
          { projectId },
        ),
        listDeliveryAttempts(
          archive,
          eventId,
          destination,
          { projectId },
        ),
      ]);

      return {
        destination,
        state,
        attempts,
      };
    }),
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
    ({ destination, state, attempts }) => ({
      destination,
      status:
        state?.status ||
        (routeEligible === false
          ? "not_routed"
          : "pending"),
      state,
      attempts,
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

  return {
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
    ownership,
    deliveries,
  };
}

export class EventInspectionConfigurationError extends Error {}

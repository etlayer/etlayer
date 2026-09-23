import { readDeliveryState, recordDeliveryState } from "./delivery-state.js";
import { exportToPostHog } from "./posthog.js";
import { exportToStatsig } from "./statsig.js";
import { resolveProjectDestinations } from "./project-config.js";
import { projectIdForEvent } from "./project-scope.js";

const DEFAULT_DESTINATIONS = [
  {
    name: "posthog",
    exportEvent: exportToPostHog,
  },
  {
    name: "statsig",
    exportEvent: exportToStatsig,
  },
];

export async function routeEventDestinations(event, env, options = {}) {
  const projectId = projectIdForEvent(event);
  const destinations =
    options.destinations ||
    await configuredDestinationsForProject(
      env.ARCHIVE,
      projectId,
    );
  const readState = options.readState || readDeliveryState;
  const recordState = options.recordState || recordDeliveryState;
  const results = [];

  for (const destination of destinations) {
    validateDestination(destination);

    const destinationOptions = options[destination.name] || {};
    const previous = await readState(
      env.ARCHIVE,
      event.id,
      destination.name,
      { projectId },
    );

    if (previous?.status === "exported") {
      results.push({
        destination: destination.name,
        status: "skipped",
        reason: "already_exported",
      });
      continue;
    }

    let result;

    try {
      result = await destination.exportEvent(
        event,
        env,
        destinationOptions,
      );
    } catch (error) {
      result = {
        status: "failed",
        error,
      };
    }

    await recordState(
      env.ARCHIVE,
      event,
      destination.name,
      result,
      {
        now: options.now,
        delivery: destinationOptions.delivery,
      },
    );

    results.push({
      destination: destination.name,
      ...result,
    });
  }

  return results;
}

function validateDestination(destination) {
  if (
    !destination ||
    typeof destination.name !== "string" ||
    destination.name.trim() === "" ||
    typeof destination.exportEvent !== "function"
  ) {
    throw new DestinationRouterConfigurationError(
      "destination must have a non-empty name and exportEvent function",
    );
  }
}

export class DestinationRouterConfigurationError extends Error {}


async function configuredDestinationsForProject(
  archive,
  projectId,
) {
  const names = new Set(
    await resolveProjectDestinations(
      archive,
      projectId,
    ),
  );

  return DEFAULT_DESTINATIONS.filter(({ name }) =>
    names.has(name),
  );
}

import { recordDeliveryState } from "./delivery-state.js";
import { exportToPostHog } from "./posthog.js";
import { exportToStatsig } from "./statsig.js";

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
  const destinations = options.destinations || DEFAULT_DESTINATIONS;
  const recordState = options.recordState || recordDeliveryState;
  const results = [];

  for (const destination of destinations) {
    validateDestination(destination);

    const destinationOptions = options[destination.name] || {};
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

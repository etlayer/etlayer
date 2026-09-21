import { exportToPostHog } from "./posthog.js";

const DEFAULT_DESTINATIONS = [
  {
    name: "posthog",
    exportEvent: exportToPostHog,
  },
];

export async function routeEventDestinations(event, env, options = {}) {
  const destinations = options.destinations || DEFAULT_DESTINATIONS;
  const results = [];

  for (const destination of destinations) {
    validateDestination(destination);

    const result = await destination.exportEvent(
      event,
      env,
      options[destination.name] || {},
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

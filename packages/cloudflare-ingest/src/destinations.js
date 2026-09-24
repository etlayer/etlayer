import { readDeliveryState, recordDeliveryState } from "./delivery-state.js";
import { exportToPostHog } from "./posthog.js";
import { exportToStatsig } from "./statsig.js";
import { projectConfiguration, resolveProjectDestinations } from "./project-config.js";
import { resolveDestinationCredential } from "./destination-credentials.js";
import { projectIdForEvent } from "./project-scope.js";
import {
  nextAttemptNumber,
  recordDeliveryAttempt,
} from "./delivery-attempt.js";

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
  const usesProjectConfiguration = !options.destinations;
  const destinations =
    options.destinations ||
    await configuredDestinationsForProject(
      env.ARCHIVE,
      projectId,
    );
  const readState = options.readState || readDeliveryState;
  const recordState = options.recordState || recordDeliveryState;
  const recordAttempt =
    options.recordAttempt || recordDeliveryAttempt;
  const results = [];

  for (const destination of destinations) {
    validateDestination(destination);

    let destinationOptions = {
      ...(options[destination.name] || {}),
    };
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

    const attemptNumber =
      nextAttemptNumber(previous);
    const startedAt =
      options.now instanceof Date
        ? options.now
        : new Date(options.now || Date.now());
    let result;

    try {
      if (
        usesProjectConfiguration &&
        !projectConfiguration(projectId)
      ) {
        const credential =
          await resolveDestinationCredential(
            env.ARCHIVE,
            env,
            projectId,
            destination.name,
            {
              crypto:
                destinationOptions.crypto ||
                options.crypto,
            },
          );

        destinationOptions = {
          ...destinationOptions,
          credential: credential.secret,
        };
      }

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

    const attempt =
      options.recordAttempt ||
      typeof env.ARCHIVE?.put === "function"
        ? await recordAttempt(
            env.ARCHIVE,
            event,
            destination.name,
            result,
            {
              attemptNumber,
              startedAt,
              now: options.now,
              delivery:
                destinationOptions.delivery,
              crypto:
                destinationOptions.crypto ||
                options.crypto,
            },
          )
        : null;

    await recordState(
      env.ARCHIVE,
      event,
      destination.name,
      result,
      {
        now: options.now,
        delivery: destinationOptions.delivery,
        attempt: attempt?.state,
      },
    );

    results.push({
      destination: destination.name,
      ...result,
      ...(attempt
        ? {
            deliveryId:
              attempt.state.deliveryId,
            attemptId:
              attempt.state.attemptId,
            attemptNumber:
              attempt.state.attemptNumber,
          }
        : {}),
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

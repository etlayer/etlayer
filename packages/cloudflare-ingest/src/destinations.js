import {
  readDeliveryState,
  recordDeliveryState,
} from "./delivery-state.js";
import {
  nextDeliveryAttemptNumber,
  recordDeliveryAttempt,
} from "./delivery-attempt.js";
import { exportToPostHog } from "./posthog.js";
import { exportToStatsig } from "./statsig.js";
import {
  projectConfiguration,
  resolveProjectDestinations,
} from "./project-config.js";
import {
  resolveDestinationCredential,
} from "./destination-credentials.js";
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

export async function routeEventDestinations(
  event,
  env,
  options = {},
) {
  const projectId = projectIdForEvent(event);
  const usesProjectConfiguration =
    !options.destinations;
  const destinations =
    options.destinations ||
    await configuredDestinationsForProject(
      env.ARCHIVE,
      projectId,
    );
  const readState =
    options.readState || readDeliveryState;
  const recordState =
    options.recordState || recordDeliveryState;
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
      options.nextAttemptNumber
        ? await options.nextAttemptNumber(
            env.ARCHIVE,
            event.id,
            destination.name,
            {
              projectId,
              previousState: previous,
            },
          )
        : await nextDeliveryAttemptNumber(
            env.ARCHIVE,
            event.id,
            destination.name,
            {
              projectId,
              previousState: previous,
            },
          );

    const delivery = {
      ...(options.delivery || {}),
      ...(destinationOptions.delivery || {}),
      mode:
        destinationOptions.delivery?.mode ||
        options.delivery?.mode ||
        "live",
    };
    const startedAt = normalizeTimestamp(
      options.now,
    );
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
          delivery,
        };
      } else {
        destinationOptions = {
          ...destinationOptions,
          delivery,
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

    const completedAt = normalizeTimestamp(
      options.now,
    );
    const shouldRecordAttempt =
      Boolean(options.recordAttempt) ||
      typeof env.ARCHIVE?.put === "function";

    const attempt = shouldRecordAttempt
      ? await recordAttempt(
          env.ARCHIVE,
          event,
          destination.name,
          result,
          {
            attemptNumber,
            startedAt,
            completedAt,
            delivery,
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
        delivery,
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

function normalizeTimestamp(value) {
  const date =
    value instanceof Date
      ? value
      : new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new DestinationRouterConfigurationError(
      "delivery timestamp is invalid",
    );
  }

  return date;
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

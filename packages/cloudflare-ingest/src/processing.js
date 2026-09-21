import { routeEventDestinations } from "./destinations.js";
import { validateEventContract } from "./event-contracts.js";
import { recordValidationState } from "./validation-state.js";

export async function processPersistedEvent(
  event,
  env,
  options = {},
) {
  const validate = options.validate || validateEventContract;
  const recordState =
    options.recordValidationState || recordValidationState;
  const route = options.route || routeEventDestinations;

  const validation = validate(event, options.validation || {});

  await recordState(
    env.ARCHIVE,
    event,
    validation,
    {
      now: options.now,
    },
  );

  if (validation.status === "blocked") {
    return {
      validation,
      deliveries: [],
    };
  }

  const deliveries = await route(
    event,
    env,
    options.routing || {},
  );

  return {
    validation,
    deliveries,
  };
}

import { resolveEventIdentity } from "./identity.js";
import { recordIdentityState } from "./identity-state.js";
import { applyDeliveryPrivacy } from "./privacy.js";
import { recordPrivacyState } from "./privacy-state.js";
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
  const applyPrivacy =
    options.applyDeliveryPrivacy || applyDeliveryPrivacy;
  const recordPrivacy =
    options.recordPrivacyState || recordPrivacyState;
  const resolveIdentity =
    options.resolveIdentity || resolveEventIdentity;
  const recordIdentity =
    options.recordIdentityState || recordIdentityState;
  const route = options.route || routeEventDestinations;

  const validation = validate(event, options.validation || {});

  await recordState(
    env.ARCHIVE,
    event,
    validation,
    {
      now: options.now,
      sourceKey: options.sourceKey,
    },
  );

  const privacy = applyPrivacy(
    event,
    options.privacy || {},
  );

  const privacyRecord = await recordPrivacy(
    env.ARCHIVE,
    event,
    privacy,
    {
      now: options.now,
      sourceKey: options.sourceKey,
    },
  );

  const identity = resolveIdentity(
    privacy.event,
    options.identity || {},
  );

  const identityRecord = await recordIdentity(
    env.ARCHIVE,
    event,
    identity,
    {
      now: options.now,
      sourceKey: options.sourceKey,
    },
  );

  if (validation.status === "blocked") {
    return {
      validation,
      privacy: privacyRecord.state,
      identity: identityRecord.state,
      deliveries: [],
    };
  }

  const deliveries = await route(
    privacy.event,
    env,
    options.routing || {},
  );

  return {
    validation,
    privacy: privacyRecord.state,
    identity: identityRecord.state,
    deliveries,
  };
}

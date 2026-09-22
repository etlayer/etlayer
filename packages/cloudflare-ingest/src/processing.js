import { evaluateEventAuthority } from "./authority.js";
import { recordAuthorityState } from "./authority-state.js";
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
  const evaluateAuthority =
    options.evaluateAuthority || evaluateEventAuthority;
  const recordAuthority =
    options.recordAuthorityState || recordAuthorityState;
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

  const authority = evaluateAuthority(
    event,
    options.authority || {},
  );

  const authorityRecord = await recordAuthority(
    env.ARCHIVE,
    event,
    authority,
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

  if (
    validation.status === "blocked" ||
    authority.status === "blocked"
  ) {
    return {
      validation,
      authority: authorityRecord.state,
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
    authority: authorityRecord.state,
    privacy: privacyRecord.state,
    identity: identityRecord.state,
    deliveries,
  };
}

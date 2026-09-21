import {
  classifyAttribute,
  deliveryActionFor,
  ingestActionFor,
  PRIVACY_POLICY_VERSION,
} from "../privacy/policy.v1.js";

export function applyIngestPrivacy(event) {
  validateManagedEvent(event);

  const resource = filterAttributes(
    event.resource,
    "resource",
    ingestActionFor,
  );
  const logRecord = filterAttributes(
    event.logRecord,
    "logRecord",
    ingestActionFor,
  );

  const ingestActions = [
    ...resource.actions,
    ...logRecord.actions,
  ];

  return {
    event: {
      ...event,
      resource: resource.container,
      logRecord: logRecord.container,
      privacy: {
        policyVersion: PRIVACY_POLICY_VERSION,
        ingestActions,
      },
    },
    policyVersion: PRIVACY_POLICY_VERSION,
    ingestActions,
  };
}

export function applyDeliveryPrivacy(event) {
  validateManagedEvent(event);

  const resource = filterAttributes(
    event.resource,
    "resource",
    deliveryActionFor,
  );
  const logRecord = filterAttributes(
    event.logRecord,
    "logRecord",
    deliveryActionFor,
  );

  return {
    event: {
      ...event,
      resource: resource.container,
      logRecord: logRecord.container,
    },
    policyVersion: PRIVACY_POLICY_VERSION,
    ingestActions: Array.isArray(event.privacy?.ingestActions)
      ? event.privacy.ingestActions
      : [],
    deliveryActions: [
      ...resource.actions,
      ...logRecord.actions,
    ],
  };
}

function filterAttributes(container, location, actionFor) {
  if (!container || typeof container !== "object") {
    return {
      container: container || {},
      actions: [],
    };
  }

  const attributes = Array.isArray(container.attributes)
    ? container.attributes
    : [];
  const kept = [];
  const actions = [];

  for (const attribute of attributes) {
    if (typeof attribute?.key !== "string") {
      kept.push(attribute);
      continue;
    }

    const classification = classifyAttribute(attribute.key);
    const action = actionFor(classification);

    if (action === "drop") {
      actions.push({
        location,
        attribute: attribute.key,
        classification,
        action: "drop",
      });
      continue;
    }

    kept.push(attribute);
  }

  return {
    container: {
      ...container,
      attributes: kept,
    },
    actions,
  };
}

function validateManagedEvent(event) {
  if (
    !event ||
    typeof event !== "object" ||
    typeof event.id !== "string" ||
    typeof event.eventName !== "string"
  ) {
    throw new PrivacyPolicyError(
      "managed event id and eventName are required",
    );
  }
}

export class PrivacyPolicyError extends Error {}

import { decodeEventAttributes } from "./event-contracts.js";

const ID_FIELDS = [
  ["user.id", "user"],
  ["actor.anonymous.id", "anonymous"],
  ["session.id", "session"],
  ["account.id", "account"],
];

export function resolveEventIdentity(event) {
  validateManagedEvent(event);

  const attributes = decodeEventAttributes(event);
  const userId = stringValue(attributes["user.id"]);
  const anonymousId = stringValue(attributes["actor.anonymous.id"]);
  const accountId = stringValue(attributes["account.id"]);
  const sessionId = stringValue(attributes["session.id"]);

  const primary = resolvePrimary({
    userId,
    anonymousId,
    sessionId,
    accountId,
    eventId: event.id,
  });

  const transition =
    event.eventName === "identity.linked" &&
    anonymousId &&
    userId
      ? {
          kind: "anonymous_to_user",
          from: anonymousId,
          to: userId,
        }
      : null;

  return {
    status:
      userId || anonymousId || sessionId || accountId
        ? "resolved"
        : "fallback",
    primary,
    anonymousId,
    userId,
    accountId,
    sessionId,
    transition,
    attribution: {
      source: stringValue(attributes["attribution.source"]),
      medium: stringValue(attributes["attribution.medium"]),
      campaign: stringValue(attributes["attribution.campaign"]),
    },
  };
}

export function identityCustomIds(identity) {
  const customIDs = {};

  if (identity.anonymousId && identity.anonymousId !== identity.userId) {
    customIDs.anonymousID = identity.anonymousId;
  }

  if (identity.sessionId && identity.sessionId !== identity.userId) {
    customIDs.sessionID = identity.sessionId;
  }

  if (identity.accountId && identity.accountId !== identity.userId) {
    customIDs.accountID = identity.accountId;
  }

  return customIDs;
}

function resolvePrimary({
  userId,
  anonymousId,
  sessionId,
  accountId,
  eventId,
}) {
  const candidates = [
    [userId, "user"],
    [anonymousId, "anonymous"],
    [sessionId, "session"],
    [accountId, "account"],
  ];

  for (const [id, kind] of candidates) {
    if (id) return { kind, id };
  }

  return {
    kind: "event",
    id: `etlayer:${eventId}`,
  };
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0
    ? value
    : null;
}

function validateManagedEvent(event) {
  if (
    !event ||
    typeof event.id !== "string" ||
    event.id.trim() === "" ||
    typeof event.eventName !== "string" ||
    event.eventName.trim() === ""
  ) {
    throw new IdentityResolutionError(
      "managed event id and eventName are required",
    );
  }
}

export class IdentityResolutionError extends Error {}

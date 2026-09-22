import { decodeEventAttributes } from "./event-contracts.js";

const ACTOR_TYPES = new Set([
  "anonymous",
  "user",
  "agent",
  "service",
  "api_key",
  "system",
  "automation",
]);

const DELEGATION_RELATIONSHIPS = new Set([
  "on_behalf_of",
  "delegated_by",
  "impersonation",
  "assumed_role",
]);

export function resolveEventIdentity(event) {
  validateManagedEvent(event);

  const attributes = decodeEventAttributes(event);
  const userId = stringValue(attributes["user.id"]);
  const anonymousId = stringValue(attributes["actor.anonymous.id"]);
  const accountId = stringValue(attributes["account.id"]);
  const sessionId = stringValue(attributes["session.id"]);
  const actor = resolveActor(attributes, {
    userId,
    anonymousId,
  });
  const delegation = resolveDelegation(attributes);

  const subject = resolveSubject({
    userId,
    anonymousId,
    actor,
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
      userId ||
      anonymousId ||
      actor ||
      sessionId ||
      accountId
        ? "resolved"
        : "fallback",
    subject,
    actor,
    delegation,
    anonymousId,
    userId,
    accountId,
    sessionId,
    transition,
    agent: {
      turnId: stringValue(attributes["agent.turn.id"]),
      toolCallId: stringValue(attributes["agent.tool_call.id"]),
    },
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

  if (
    identity.actor?.id &&
    identity.actor.id !== identity.userId &&
    identity.actor.id !== identity.anonymousId
  ) {
    const key =
      identity.actor.type === "agent"
        ? "agentID"
        : "actorID";
    customIDs[key] = identity.actor.id;
  }

  return customIDs;
}

function resolveActor(attributes, { userId, anonymousId }) {
  const explicitType = stringValue(attributes["actor.type"]);
  const explicitId = stringValue(attributes["actor.id"]);

  if (explicitType || explicitId) {
    if (
      !explicitType ||
      !explicitId ||
      !ACTOR_TYPES.has(explicitType)
    ) {
      throw new IdentityResolutionError(
        "explicit actor requires a supported actor.type and actor.id",
      );
    }

    return {
      type: explicitType,
      id: explicitId,
      source: "explicit",
    };
  }

  if (userId) {
    return {
      type: "user",
      id: userId,
      source: "inferred",
    };
  }

  if (anonymousId) {
    return {
      type: "anonymous",
      id: anonymousId,
      source: "inferred",
    };
  }

  return null;
}

function resolveDelegation(attributes) {
  const entries = new Map();

  for (const [key, value] of Object.entries(attributes)) {
    const match = key.match(
      /^delegation\.(\d+)\.(relationship|principal\.type|principal\.id|reason|reference)$/,
    );
    if (!match) continue;

    const index = Number(match[1]);
    const field = match[2];
    const entry = entries.get(index) || {
      relationship: null,
      principal: {
        type: null,
        id: null,
      },
      reason: null,
      reference: null,
    };

    if (field === "relationship") {
      entry.relationship = stringValue(value);
    } else if (field === "principal.type") {
      entry.principal.type = stringValue(value);
    } else if (field === "principal.id") {
      entry.principal.id = stringValue(value);
    } else if (field === "reason") {
      entry.reason = stringValue(value);
    } else if (field === "reference") {
      entry.reference = stringValue(value);
    }

    entries.set(index, entry);
  }

  const delegation = [...entries.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, entry]) => {
      if (
        !entry.relationship ||
        !DELEGATION_RELATIONSHIPS.has(entry.relationship) ||
        !entry.principal.type ||
        !entry.principal.id
      ) {
        throw new IdentityResolutionError(
          `delegation.${index} is incomplete or invalid`,
        );
      }

      return {
        relationship: entry.relationship,
        principal: {
          type: entry.principal.type,
          id: entry.principal.id,
        },
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.reference ? { reference: entry.reference } : {}),
      };
    });

  return delegation;
}

function resolveSubject({
  userId,
  anonymousId,
  actor,
  sessionId,
  accountId,
  eventId,
}) {
  const candidates = [
    [userId, "user"],
    [anonymousId, "anonymous"],
    [
      actor?.id &&
      actor.type !== "user" &&
      actor.type !== "anonymous"
        ? actor.id
        : null,
      actor?.type || "actor",
    ],
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

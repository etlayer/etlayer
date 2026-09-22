import {
  identityCustomIds,
  resolveEventIdentity,
} from "./identity.js";

const DEFAULT_STATSIG_HOST = "https://api.statsig.com";

export async function exportToStatsig(event, env, options = {}) {
  if (env.STATSIG_EXPORT_DISABLED === "1") {
    return { status: "skipped", reason: "statsig_disabled" };
  }

  if (!env.STATSIG_SERVER_SECRET) {
    return { status: "skipped", reason: "statsig_not_configured" };
  }

  const fetchImpl = options.fetch || fetch;
  const payload = projectToStatsig(event, {
    delivery: options.delivery,
  });

  const host = String(env.STATSIG_HOST || DEFAULT_STATSIG_HOST).replace(/\/$/, "");
  const response = await fetchImpl(`${host}/v1/log_event`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "statsig-api-key": env.STATSIG_SERVER_SECRET,
    },
    body: JSON.stringify({
      events: [payload],
    }),
  });

  if (!response.ok) {
    const body = await safeResponseText(response);
    throw new StatsigExportError(
      `Statsig log_event failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
      response.status,
    );
  }

  return {
    status: "exported",
    eventId: event.id,
  };
}

export function projectToStatsig(event, options = {}) {
  validateManagedEvent(event);

  const resourceAttributes = decodeAttributes(event.resource?.attributes);
  const eventAttributes = decodeAttributes(event.logRecord?.attributes);
  const properties = {
    ...resourceAttributes,
    ...eventAttributes,
  };

  const identity = resolveEventIdentity(event);
  const user = statsigUser(identity);
  const metadata = buildMetadata(event, properties, options.delivery);

  return {
    eventName: event.eventName,
    time: eventTimestamp(event),
    user,
    metadata,
  };
}

function statsigUser(identity) {
  const user = {};
  const customIDs = identityCustomIds(identity);

  if (identity.userId) {
    user.userID = identity.userId;
  }

  if (Object.keys(customIDs).length > 0) {
    user.customIDs = customIDs;
  }

  if (!user.userID && !user.customIDs) {
    user.userID = identity.subject.id;
  }

  return user;
}

function buildMetadata(event, properties, delivery) {
  const metadata = {
    "etlayer.event.id": event.id,
    "etlayer.received_at": event.receivedAt,
  };

  if (event.scope?.name) metadata["otel.scope.name"] = event.scope.name;
  if (event.scope?.version) metadata["otel.scope.version"] = event.scope.version;
  if (event.logRecord?.traceId) metadata["otel.trace_id"] = event.logRecord.traceId;
  if (event.logRecord?.spanId) metadata["otel.span_id"] = event.logRecord.spanId;

  for (const [key, value] of Object.entries(properties)) {
    if (value == null) continue;
    metadata[key] = metadataValue(value);
  }

  if (delivery?.mode) {
    metadata["etlayer.delivery.mode"] = delivery.mode;
  }

  if (delivery?.replayId) {
    metadata["etlayer.replay.id"] = delivery.replayId;
  }

  return metadata;
}

function metadataValue(value) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  return JSON.stringify(value);
}

function eventTimestamp(event) {
  const unixNano = event.occurredAtUnixNano;

  if (typeof unixNano === "string" && /^\d+$/.test(unixNano)) {
    try {
      const millis = BigInt(unixNano) / 1_000_000n;
      const date = new Date(Number(millis));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    } catch {
      // Fall back to trusted ETLayer receive time.
    }
  }

  return new Date(event.receivedAt).toISOString();
}

function decodeAttributes(attributes) {
  if (!Array.isArray(attributes)) return {};

  return Object.fromEntries(
    attributes
      .filter((attribute) => typeof attribute?.key === "string")
      .map((attribute) => [attribute.key, decodeAnyValue(attribute.value)]),
  );
}

function decodeAnyValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("bytesValue" in value) return value.bytesValue;
  if (value.arrayValue?.values) {
    return value.arrayValue.values.map(decodeAnyValue);
  }
  if (value.kvlistValue?.values) {
    return Object.fromEntries(
      value.kvlistValue.values.map((entry) => [
        entry.key,
        decodeAnyValue(entry.value),
      ]),
    );
  }
  return null;
}

function validateManagedEvent(event) {
  if (!event || typeof event !== "object") {
    throw new StatsigProjectionError("managed event must be an object");
  }

  for (const field of ["id", "eventName", "receivedAt"]) {
    if (typeof event[field] !== "string" || event[field].trim() === "") {
      throw new StatsigProjectionError(`${field} must be a non-empty string`);
    }
  }
}

async function safeResponseText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

export class StatsigProjectionError extends Error {}
export class StatsigExportError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

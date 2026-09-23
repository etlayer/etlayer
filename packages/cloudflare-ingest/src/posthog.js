import { projectIdForEvent } from "./project-scope.js";
import { resolveEventIdentity } from "./identity.js";

export async function exportToPostHog(event, env, options = {}) {
  if (env.POSTHOG_EXPORT_DISABLED === "1") {
    return { status: "skipped", reason: "posthog_disabled" };
  }

  const projectToken =
    Object.hasOwn(options, "credential")
      ? options.credential
      : env.POSTHOG_PROJECT_TOKEN;

  if (!projectToken) {
    return { status: "skipped", reason: "posthog_not_configured" };
  }

  if (!env.POSTHOG_HOST) {
    throw new PostHogConfigurationError(
      "POSTHOG_HOST is required when POSTHOG_PROJECT_TOKEN is configured",
    );
  }

  const fetchImpl = options.fetch || fetch;
  const payload = await projectToPostHog(event, {
    crypto: options.crypto || globalThis.crypto,
    delivery: options.delivery,
  });

  const host = String(env.POSTHOG_HOST).replace(/\/$/, "");
  const response = await fetchImpl(`${host}/i/v0/e/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      api_key: projectToken,
      ...payload,
    }),
  });

  if (!response.ok) {
    const body = await safeResponseText(response);
    throw new PostHogExportError(
      `PostHog capture failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
      response.status,
    );
  }

  return {
    status: "exported",
    eventId: event.id,
    uuid: payload.uuid,
  };
}

export async function projectToPostHog(event, options = {}) {
  validateManagedEvent(event);

  const resourceAttributes = decodeAttributes(event.resource?.attributes);
  const eventAttributes = decodeAttributes(event.logRecord?.attributes);
  const properties = {
    ...resourceAttributes,
    ...eventAttributes,
    "etlayer.event.id": event.id,
    "etlayer.received_at": event.receivedAt,
    "etlayer.project.id": projectIdForEvent(event),
  };

  if (event.scope?.name) properties["otel.scope.name"] = event.scope.name;
  if (event.scope?.version) properties["otel.scope.version"] = event.scope.version;
  if (event.logRecord?.traceId) properties["otel.trace_id"] = event.logRecord.traceId;
  if (event.logRecord?.spanId) properties["otel.span_id"] = event.logRecord.spanId;

  addDeliveryMetadata(properties, options.delivery);

  const identity = resolveEventIdentity(event);
  const isIdentityLink =
    event.eventName === "identity.linked" &&
    identity.userId &&
    identity.anonymousId;

  if (isIdentityLink) {
    properties.$anon_distinct_id = identity.anonymousId;
  } else if (
    identity.subject.kind !== "user" &&
    identity.subject.kind !== "anonymous"
  ) {
    properties.$process_person_profile = false;
  }

  return {
    event: isIdentityLink ? "$identify" : event.eventName,
    distinct_id: isIdentityLink
      ? identity.userId
      : identity.subject.id.slice(0, 200),
    timestamp: eventTimestamp(event),
    uuid: await stablePostHogUuid(event.id, options.crypto || globalThis.crypto),
    properties,
  };
}

export async function stablePostHogUuid(eventId, cryptoImpl = globalThis.crypto) {
  if (isUuid(eventId)) return eventId.toLowerCase();

  if (!cryptoImpl?.subtle) {
    throw new PostHogConfigurationError(
      "Web Crypto is required to derive deterministic PostHog UUIDs",
    );
  }

  const input = new TextEncoder().encode(eventId);
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", input));
  const bytes = digest.slice(0, 16);

  // RFC 4122 variant + version 5 bits. The content is SHA-256-derived, but the
  // UUID bits make the value syntactically valid while remaining deterministic.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function addDeliveryMetadata(properties, delivery) {
  if (!delivery || typeof delivery !== "object") return;

  if (typeof delivery.mode === "string" && delivery.mode.length > 0) {
    properties["etlayer.delivery.mode"] = delivery.mode;
  }

  if (typeof delivery.replayId === "string" && delivery.replayId.length > 0) {
    properties["etlayer.replay.id"] = delivery.replayId;
  }
}

function eventTimestamp(event) {
  const unixNano = event.occurredAtUnixNano;
  if (typeof unixNano === "string" && /^\d+$/.test(unixNano)) {
    try {
      const millis = BigInt(unixNano) / 1_000_000n;
      const date = new Date(Number(millis));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    } catch {
      // Fall through to trusted ETLayer receive time.
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
    throw new PostHogProjectionError("managed event must be an object");
  }

  for (const field of ["id", "eventName", "receivedAt"]) {
    if (typeof event[field] !== "string" || event[field].trim() === "") {
      throw new PostHogProjectionError(`${field} must be a non-empty string`);
    }
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function safeResponseText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

export class PostHogProjectionError extends Error {}
export class PostHogConfigurationError extends Error {}
export class PostHogExportError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

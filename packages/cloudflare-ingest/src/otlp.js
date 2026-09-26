import { applyIngestPrivacy } from "./privacy.js";
import {
  authenticateIngest,
  stampTrustedProvenance,
} from "./provenance.js";

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENTS_PER_REQUEST = 1000;
const DEFAULT_RATE_LIMIT_PERIOD_SECONDS = 60;
const QUEUE_BATCH_SIZE = 100;

export async function handleExportLogs(request, env, options = {}) {
  const authenticate =
    options.authenticateIngest || authenticateIngest;
  const stampProvenance =
    options.stampTrustedProvenance ||
    stampTrustedProvenance;
  const authentication = await authenticate(request, env, {
    crypto: options.crypto,
  });

  if (!authentication.ok) {
    if (
      authentication.reason ===
      "ingest_credentials_not_configured"
    ) {
      return otlpError(
        503,
        14,
        "ingest credentials are not configured",
      );
    }

    return otlpError(
      401,
      16,
      "invalid ingest credential",
    );
  }

  const rateLimit =
    await applyProjectRateLimit(
      env,
      authentication.provenance.projectId,
    );

  if (!rateLimit.success) {
    return otlpError(
      429,
      8,
      "ingest rate limit exceeded",
      {
        "retry-after": String(
          parsePositiveInteger(
            env.ETLAYER_INGEST_RATE_LIMIT_PERIOD_SECONDS,
            DEFAULT_RATE_LIMIT_PERIOD_SECONDS,
          ),
        ),
      },
    );
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return otlpError(415, 3, "content-type must be application/json");
  }

  const maxRequestBytes = parseMaxRequestBytes(env.ETLAYER_MAX_REQUEST_BYTES);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxRequestBytes) {
    return otlpError(413, 8, "request body exceeds ingest limit");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxRequestBytes) {
    return otlpError(413, 8, "request body exceeds ingest limit");
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return otlpError(400, 3, "request body is not valid JSON");
  }

  let events;
  try {
    events = normalizeExportLogsRequest(payload, {
      receivedAt: options.receivedAt || new Date().toISOString(),
      idFactory: options.idFactory || (() => crypto.randomUUID()),
    });
  } catch (error) {
    if (error instanceof OtlpValidationError) {
      return otlpError(400, 3, error.message);
    }
    throw error;
  }

  const maxEventsPerRequest =
    parsePositiveInteger(
      env.ETLAYER_MAX_EVENTS_PER_REQUEST,
      DEFAULT_MAX_EVENTS_PER_REQUEST,
    );

  if (
    events.length >
    maxEventsPerRequest
  ) {
    return otlpError(
      413,
      8,
      "request contains too many events",
    );
  }

  const applyPrivacy =
    options.applyIngestPrivacy || applyIngestPrivacy;

  events = events.map((event) => {
    const trusted = stampProvenance(
      event,
      authentication.provenance,
    );
    return applyPrivacy(trusted).event;
  });

  if (!env.EVENTS || typeof env.EVENTS.sendBatch !== "function") {
    return otlpError(503, 14, "event queue is not configured");
  }

  for (const batch of chunks(events, QUEUE_BATCH_SIZE)) {
    await env.EVENTS.sendBatch(batch.map((body) => ({ body })));
  }

  // OTLP/HTTP success uses HTTP 200 and an empty ExportLogsServiceResponse.
  return new Response("{}", {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function normalizeExportLogsRequest(payload, { receivedAt, idFactory }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new OtlpValidationError("OTLP payload must be a JSON object");
  }

  if (!Array.isArray(payload.resourceLogs)) {
    throw new OtlpValidationError("resourceLogs must be an array");
  }

  const events = [];

  for (const resourceLogs of payload.resourceLogs) {
    const resource = resourceLogs?.resource || {};
    const scopeLogsList = resourceLogs?.scopeLogs;

    if (!Array.isArray(scopeLogsList)) {
      throw new OtlpValidationError("scopeLogs must be an array");
    }

    for (const scopeLogs of scopeLogsList) {
      const scope = scopeLogs?.scope || {};
      const logRecords = scopeLogs?.logRecords;

      if (!Array.isArray(logRecords)) {
        throw new OtlpValidationError("logRecords must be an array");
      }

      for (const logRecord of logRecords) {
        const eventName = logRecord?.eventName;
        if (typeof eventName !== "string" || eventName.trim() === "") {
          throw new OtlpValidationError(
            "ETLayer accepts event log records with a non-empty eventName",
          );
        }

        const suppliedEventId = readStringAttribute(
          logRecord.attributes,
          "etlayer.event.id",
        );

        events.push({
          id: suppliedEventId || idFactory(),
          eventName,
          occurredAtUnixNano: logRecord.timeUnixNano || null,
          observedAtUnixNano: logRecord.observedTimeUnixNano || null,
          receivedAt,
          resource,
          scope,
          logRecord,
        });
      }
    }
  }

  if (events.length === 0) {
    throw new OtlpValidationError("OTLP request contains no event log records");
  }

  return events;
}

function isJsonContentType(contentType) {
  if (!contentType) return false;
  return contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function parseMaxRequestBytes(value) {
  return parsePositiveInteger(
    value,
    DEFAULT_MAX_REQUEST_BYTES,
  );
}

function parsePositiveInteger(
  value,
  fallback,
) {
  if (!value) return fallback;

  const parsed = Number(value);

  return (
    Number.isSafeInteger(parsed) &&
    parsed > 0
  )
    ? parsed
    : fallback;
}

async function applyProjectRateLimit(
  env,
  projectId,
) {
  const limiter =
    env.ETLAYER_INGEST_RATE_LIMITER;

  if (
    !limiter ||
    typeof limiter.limit !== "function"
  ) {
    return {
      success: true,
      enforced: false,
    };
  }

  const result = await limiter.limit({
    key: projectId,
  });

  return {
    success: result?.success !== false,
    enforced: true,
  };
}

function readStringAttribute(attributes, key) {
  if (!Array.isArray(attributes)) return null;

  const attribute = attributes.find((candidate) => candidate?.key === key);
  const value = attribute?.value?.stringValue;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function otlpError(
  status,
  code,
  message,
  headers = {},
) {
  return new Response(
    JSON.stringify({ code, message }),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...headers,
      },
    },
  );
}

function* chunks(items, size) {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}

class OtlpValidationError extends Error {}

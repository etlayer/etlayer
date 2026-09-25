import {
  EventInspectionConfigurationError,
  inspectEventState,
} from "./event-inspection.js";
import {
  IdempotencyConfigurationError,
  IdempotencyDecryptionError,
  IdempotencyKeyExpiredError,
  IdempotencyKeyReusedError,
  IdempotencyValidationError,
  beginIdempotentOperation,
  completeIdempotentOperation,
  fingerprintSemanticRequest,
} from "./idempotency.js";
import {
  OnboardingConflictError,
  OnboardingNotFoundError,
  OnboardingValidationError,
  ensureOnboarding,
  normalizeOnboardingRequest,
} from "./onboarding-domain.js";
import { buildPublicOnboardingBundle } from "./onboarding.js";
import { authenticateProjectOperator } from "./operator-auth.js";
import { validateProjectId } from "./project-config.js";
import { generateCredential } from "./registry.js";

const ONBOARDING_OPERATION = "onboarding-v1";

export async function handlePublicApiRequest(
  request,
  env,
  url = new URL(request.url),
  options = {},
) {
  try {
    const onboarding = url.pathname.match(
      /^\/api\/v1\/projects\/([^/]+)\/onboarding$/,
    );
    if (request.method === "POST" && onboarding) {
      return await publicOnboarding(
        request,
        env,
        decodePath(onboarding[1]),
        options,
      );
    }

    const eventStatus = url.pathname.match(
      /^\/api\/v1\/projects\/([^/]+)\/events\/([^/]+)$/,
    );
    if (request.method === "GET" && eventStatus) {
      return await publicEventStatus(
        request,
        env,
        decodePath(eventStatus[1]),
        decodePath(eventStatus[2]),
        options,
      );
    }

    return publicError(
      404,
      "not_found",
      "Public API route not found",
    );
  } catch (error) {
    return unexpectedError(error);
  }
}

async function publicOnboarding(
  request,
  env,
  projectId,
  options,
) {
  const projectError = validatePublicProjectId(projectId);
  if (projectError) return projectError;

  const authentication = await authenticateOperator(
    request,
    env,
    projectId,
    options,
  );
  if (authentication) return authentication;

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return publicError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json",
    );
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return publicError(
      400,
      "invalid_request",
      "Request body is not valid JSON",
    );
  }

  let normalized;
  try {
    normalized = normalizeOnboardingRequest(input);
  } catch (error) {
    return publicError(
      400,
      "invalid_request",
      publicMessage(error, "Invalid onboarding request"),
    );
  }

  const idempotencyKey =
    request.headers.get("idempotency-key");
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim() === "" ||
    idempotencyKey.length > 255
  ) {
    return publicError(
      400,
      "idempotency_key_required",
      "A non-empty Idempotency-Key header up to 255 characters is required",
    );
  }

  const cryptoImpl =
    options.crypto || globalThis.crypto;
  const now = options.now || new Date();

  let requestFingerprint;
  try {
    requestFingerprint =
      await fingerprintSemanticRequest(
        {
          operation: "onboarding.v1",
          projectId,
          producerId: normalized.producerId,
          destinations: normalized.destinations,
        },
        cryptoImpl,
      );
  } catch (error) {
    return idempotencyError(error);
  }

  const generatedCredential = generateCredential(
    "etl_prod",
    cryptoImpl,
  );

  let operation;
  try {
    operation = await beginIdempotentOperation(
      env.ARCHIVE,
      env,
      {
        projectId,
        operation: ONBOARDING_OPERATION,
        idempotencyKey,
        requestFingerprint,
        recoveryPayload: {
          credential: generatedCredential,
        },
        now,
        replaySeconds: options.replaySeconds,
        crypto: cryptoImpl,
      },
    );
  } catch (error) {
    return idempotencyError(error);
  }

  if (operation.replayed) {
    return publicJson(
      operation.payload,
      operation.record.statusCode || 201,
      {
        "idempotency-replayed": "true",
      },
    );
  }

  const credential = operation.payload?.credential;
  if (
    typeof credential !== "string" ||
    credential.length === 0
  ) {
    return publicError(
      500,
      "internal_error",
      "Public onboarding operation could not be recovered",
    );
  }

  let onboarded;
  try {
    onboarded = await ensureOnboarding(
      env.ARCHIVE,
      {
        projectId,
        ...normalized,
        credential,
        now,
        crypto: cryptoImpl,
      },
    );
  } catch (error) {
    return onboardingError(error);
  }

  const bundle = buildPublicOnboardingBundle({
    requestUrl: request.url,
    projectId,
    producer: onboarded.producer,
    credential,
    destinations: onboarded.destinations,
  });

  try {
    const completed =
      await completeIdempotentOperation(
        env.ARCHIVE,
        env,
        {
          key: operation.key,
          record: {
            ...operation.record,
            statusCode: 201,
          },
          responsePayload: bundle,
          now,
          crypto: cryptoImpl,
        },
      );

    return publicJson(bundle, 201, {
      "idempotency-replayed":
        completed.status === "completed"
          ? "false"
          : "false",
    });
  } catch (error) {
    return idempotencyError(error);
  }
}

async function publicEventStatus(
  request,
  env,
  projectId,
  eventId,
  options,
) {
  const projectError = validatePublicProjectId(projectId);
  if (projectError) return projectError;

  if (
    typeof eventId !== "string" ||
    eventId.trim() === "" ||
    eventId.length > 512
  ) {
    return publicError(
      400,
      "invalid_request",
      "Event ID is required",
    );
  }

  const authentication = await authenticateOperator(
    request,
    env,
    projectId,
    options,
  );
  if (authentication) return authentication;

  try {
    const inspected = await inspectEventState(
      env.ARCHIVE,
      projectId,
      eventId,
    );

    return publicJson(
      {
        apiVersion: "v1",
        projectId,
        eventId,
        status: inspected.status,
        known: inspected.known,
        validation:
          sanitizePublicEvidence(inspected.validation),
        authority:
          sanitizePublicEvidence(inspected.authority),
        privacy:
          sanitizePublicEvidence(inspected.privacy),
        identity:
          sanitizePublicEvidence(inspected.identity),
        decision:
          sanitizePublicEvidence(inspected.decision),
        ownership:
          sanitizePublicEvidence(inspected.ownership),
        deliveries:
          sanitizePublicDeliveries(inspected.deliveries),
      },
      200,
    );
  } catch (error) {
    if (
      error instanceof
      EventInspectionConfigurationError
    ) {
      return publicError(
        503,
        "service_unavailable",
        "Event status is temporarily unavailable",
      );
    }

    return publicError(
      404,
      "project_not_found",
      "Project is unavailable",
    );
  }
}

async function authenticateOperator(
  request,
  env,
  projectId,
  options,
) {
  const authenticate =
    options.authenticateProjectOperator ||
    authenticateProjectOperator;
  const authentication = await authenticate(
    request,
    env,
    projectId,
    { crypto: options.crypto },
  );

  if (authentication.ok) return null;

  if (
    authentication.reason ===
    "operator_credential_not_configured"
  ) {
    return publicError(
      503,
      "service_unavailable",
      "Project operator authentication is unavailable",
    );
  }

  if (authentication.reason === "unknown_project") {
    return publicError(
      404,
      "project_not_found",
      "Project not found",
    );
  }

  return publicError(
    401,
    "invalid_operator_credential",
    "Invalid operator credential for project",
  );
}

function validatePublicProjectId(projectId) {
  try {
    validateProjectId(projectId);
    return null;
  } catch {
    return publicError(
      400,
      "invalid_request",
      "Project ID must be a valid lowercase slug",
    );
  }
}

function onboardingError(error) {
  if (error instanceof OnboardingValidationError) {
    return publicError(
      400,
      "invalid_request",
      publicMessage(error, "Invalid onboarding request"),
    );
  }

  if (error instanceof OnboardingNotFoundError) {
    return publicError(
      404,
      "project_not_found",
      "Project not found",
    );
  }

  if (error instanceof OnboardingConflictError) {
    return publicError(
      409,
      "onboarding_conflict",
      "Onboarding conflicts with existing project state",
    );
  }

  return unexpectedError(error);
}

function idempotencyError(error) {
  if (error instanceof IdempotencyValidationError) {
    return publicError(
      400,
      "idempotency_key_required",
      publicMessage(
        error,
        "A valid Idempotency-Key header is required",
      ),
    );
  }

  if (error instanceof IdempotencyKeyReusedError) {
    return publicError(
      409,
      "idempotency_key_reused",
      "Idempotency key was already used with a different request",
    );
  }

  if (error instanceof IdempotencyKeyExpiredError) {
    return publicError(
      409,
      "idempotency_key_expired",
      "Idempotency replay window has expired",
    );
  }

  if (error instanceof IdempotencyConfigurationError) {
    return publicError(
      503,
      "service_unavailable",
      "Public idempotency service is unavailable",
    );
  }

  if (error instanceof IdempotencyDecryptionError) {
    return publicError(
      500,
      "internal_error",
      "Stored idempotency result is unreadable",
    );
  }

  return unexpectedError(error);
}

function sanitizePublicDeliveries(deliveries) {
  if (!Array.isArray(deliveries)) return [];

  return deliveries.map((delivery) => {
    const state = sanitizePublicEvidence(
      delivery.state,
    );

    if (state && typeof state === "object") {
      delete state.deliveryId;
      delete state.attemptCount;
      delete state.latestAttemptId;
      delete state.latestAttemptNumber;
      delete state.lastAttemptAt;
    }

    return {
      destination: delivery.destination,
      status: delivery.status,
      state,
    };
  });
}

function sanitizePublicEvidence(value) {
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizePublicEvidence(item),
    );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const result = {};

    for (const [key, item] of Object.entries(value)) {
      if (
        key === "sourceKey" ||
        key === "key" ||
        key === "versionKey" ||
        key === "ciphertext" ||
        key === "iv" ||
        key === "credentialFingerprint" ||
        key === "operatorFingerprint"
      ) {
        continue;
      }

      result[key] = sanitizePublicEvidence(item);
    }

    return result;
  }

  return value;
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function isJsonContentType(contentType) {
  if (!contentType) return false;

  return (
    contentType.split(";", 1)[0].trim().toLowerCase() ===
    "application/json"
  );
}

function publicMessage(error, fallback) {
  return error instanceof Error &&
    typeof error.message === "string" &&
    error.message.length > 0
    ? error.message
    : fallback;
}

function unexpectedError() {
  return publicError(
    500,
    "internal_error",
    "Unexpected ETLayer error",
  );
}

function publicError(status, code, message) {
  return publicJson(
    {
      error: {
        code,
        message,
      },
    },
    status,
  );
}

function publicJson(
  body,
  status,
  extraHeaders = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type":
        "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

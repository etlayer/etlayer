export const DECISION_HISTORY_VERSION = 1;

export async function recordDecisionHistory(
  archive,
  event,
  evaluation,
  options = {},
) {
  if (!archive || typeof archive.put !== "function") {
    throw new DecisionHistoryConfigurationError(
      "archive bucket is not configured for decision history",
    );
  }

  validateEvent(event);
  validateEvaluation(evaluation);

  const now =
    options.now instanceof Date
      ? options.now
      : new Date(options.now || Date.now());

  if (Number.isNaN(now.getTime())) {
    throw new DecisionHistoryConfigurationError(
      "decision history timestamp is invalid",
    );
  }

  const decisionId =
    normalizeDecisionId(options.decisionId) ||
    globalThis.crypto?.randomUUID?.();

  if (!decisionId) {
    throw new DecisionHistoryConfigurationError(
      "decision id could not be generated",
    );
  }

  const evaluationKind = normalizeEvaluationKind(
    options.evaluationKind,
  );
  const sourceKey =
    typeof options.sourceKey === "string" &&
    options.sourceKey.length > 0
      ? options.sourceKey
      : null;

  const validation = evaluation.validation;
  const authority = evaluation.authority;
  const privacy = evaluation.privacy;

  const state = {
    version: DECISION_HISTORY_VERSION,
    decisionId,
    eventId: event.id,
    eventName: event.eventName,
    evaluationKind,
    sourceKey,
    evaluatedAt: now.toISOString(),
    provenance: {
      version: event.provenance?.version || null,
      profileId: event.provenance?.profileId || null,
      producerKind: event.provenance?.producer?.kind || null,
    },
    validation: {
      status: validation.status,
      validatorVersion: validation.validatorVersion,
      schemaVersion: validation.schemaVersion,
      contractId: validation.contractId,
      errors: validation.errors || [],
    },
    authority: {
      status: authority.status,
      policyVersion: authority.policyVersion,
      profileId: authority.profileId,
      trustedProducerKind: authority.trustedProducerKind,
      claim: authority.claim,
      errors: authority.errors || [],
    },
    privacy: {
      status: privacy.status,
      policyVersion: privacy.policyVersion,
      ingestActions: privacy.ingestActions || [],
      deliveryActions: privacy.deliveryActions || [],
    },
    routeEligible:
      validation.status !== "blocked" &&
      authority.status !== "blocked",
  };

  const key = decisionHistoryKey(event.id, decisionId);

  await archive.put(key, JSON.stringify(state), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    customMetadata: {
      event_id: event.id,
      event_name: event.eventName,
      decision_id: decisionId,
      evaluation_kind: evaluationKind,
      validation_status: validation.status,
      authority_status: authority.status,
      route_eligible: String(state.routeEligible),
      source_key: sourceKey || "",
      evaluated_at: state.evaluatedAt,
    },
  });

  await archive.put(
    latestDecisionKey(event.id),
    JSON.stringify({
      version: 1,
      eventId: event.id,
      decisionId,
      key,
      evaluationKind,
      evaluatedAt: state.evaluatedAt,
    }),
    {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
      customMetadata: {
        event_id: event.id,
        decision_id: decisionId,
        decision_key: key,
        evaluation_kind: evaluationKind,
        evaluated_at: state.evaluatedAt,
      },
    },
  );

  return { key, state };
}

export async function readDecisionHistory(
  archive,
  eventId,
  decisionId,
) {
  if (!archive || typeof archive.get !== "function") return null;

  return readJsonObject(
    archive,
    decisionHistoryKey(eventId, decisionId),
  );
}

export async function readLatestDecisionPointer(
  archive,
  eventId,
) {
  if (!archive || typeof archive.get !== "function") return null;

  return readJsonObject(archive, latestDecisionKey(eventId));
}

export function decisionHistoryKey(eventId, decisionId) {
  validateIdentifier(eventId, "event id");
  validateIdentifier(decisionId, "decision id");

  return `decisions/${encodeURIComponent(eventId)}/${encodeURIComponent(decisionId)}.json`;
}

export function latestDecisionKey(eventId) {
  validateIdentifier(eventId, "event id");

  return `decision-latest/${encodeURIComponent(eventId)}.json`;
}

async function readJsonObject(archive, key) {
  const object = await archive.get(key);
  if (!object) return null;

  const text =
    typeof object.text === "function"
      ? await object.text()
      : object.body != null
        ? await new Response(object.body).text()
        : null;

  if (text == null) {
    throw new DecisionHistoryConfigurationError(
      `decision evidence has no readable body: ${key}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new DecisionHistoryConfigurationError(
      `decision evidence is not valid JSON: ${key}`,
    );
  }
}

function normalizeDecisionId(value) {
  if (value == null) return null;
  validateIdentifier(value, "decision id");
  return value;
}

function normalizeEvaluationKind(value) {
  if (value == null) return "processing";

  if (!["processing", "revalidation"].includes(value)) {
    throw new DecisionHistoryConfigurationError(
      "evaluation kind must be processing or revalidation",
    );
  }

  return value;
}

function validateEvent(event) {
  if (
    !event ||
    typeof event.id !== "string" ||
    event.id.trim() === "" ||
    typeof event.eventName !== "string" ||
    event.eventName.trim() === ""
  ) {
    throw new DecisionHistoryConfigurationError(
      "managed event id and eventName are required",
    );
  }
}

function validateEvaluation(evaluation) {
  if (
    !evaluation ||
    !evaluation.validation ||
    !evaluation.authority ||
    !evaluation.privacy ||
    !Number.isSafeInteger(
      evaluation.validation.validatorVersion,
    ) ||
    evaluation.validation.validatorVersion < 1 ||
    !Number.isSafeInteger(evaluation.authority.policyVersion) ||
    evaluation.authority.policyVersion < 1 ||
    !Number.isSafeInteger(evaluation.privacy.policyVersion) ||
    evaluation.privacy.policyVersion < 1
  ) {
    throw new DecisionHistoryConfigurationError(
      "decision evaluation must include versioned validation, authority, and privacy evidence",
    );
  }
}

function validateIdentifier(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DecisionHistoryConfigurationError(
      `${label} must be a non-empty string`,
    );
  }
}

export class DecisionHistoryConfigurationError extends Error {}

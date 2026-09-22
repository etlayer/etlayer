import { projectIdForEvent, scopedProjectKey } from "./project-scope.js";

export async function consumeEventBatch(batch, env, options = {}) {
  const logger = options.logger || console;
  const afterPersist = options.afterPersist || (async () => {});

  for (const message of batch.messages) {
    try {
      const archiveResult = await persistManagedEvent(
        env.ARCHIVE,
        message.body,
        options,
      );
      await afterPersist(message.body, archiveResult);
      message.ack();
    } catch (error) {
      logger.error?.("failed to process ETLayer event", {
        eventId: message.body?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }
}

export async function persistManagedEvent(archive, event, options = {}) {
  if (!archive || typeof archive.put !== "function" || typeof archive.head !== "function") {
    throw new ArchiveConfigurationError("archive bucket is not configured");
  }

  validateManagedEvent(event);

  const projectId = projectIdForEvent(event);
  const key = archiveKey(event);
  const serialized = JSON.stringify(event);
  const sha256 = await digestHex(serialized, options.crypto || globalThis.crypto);

  const stored = await archive.put(key, serialized, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      project_id: projectId,
      event_id: event.id,
      event_name: event.eventName,
      received_at: event.receivedAt,
      sha256,
    },
  });

  if (stored !== null) {
    return { status: "stored", key, sha256 };
  }

  const existing = await archive.head(key);
  if (existing?.customMetadata?.sha256 === sha256) {
    return { status: "duplicate", key, sha256 };
  }

  throw new EventIdConflictError(
    `archive key already exists with different content: ${key}`,
  );
}

export function archiveKey(event) {
  validateManagedEvent(event);

  const receivedAt = new Date(event.receivedAt);
  if (Number.isNaN(receivedAt.getTime())) {
    throw new ArchiveValidationError("receivedAt must be an ISO-compatible timestamp");
  }

  const yyyy = String(receivedAt.getUTCFullYear()).padStart(4, "0");
  const mm = String(receivedAt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(receivedAt.getUTCDate()).padStart(2, "0");
  const hh = String(receivedAt.getUTCHours()).padStart(2, "0");
  const encodedId = encodeURIComponent(event.id);

  return scopedProjectKey(
    projectIdForEvent(event),
    `events/${yyyy}/${mm}/${dd}/${hh}/${encodedId}.json`,
  );
}

function validateManagedEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new ArchiveValidationError("managed event must be an object");
  }

  for (const field of ["id", "eventName", "receivedAt"]) {
    if (typeof event[field] !== "string" || event[field].trim() === "") {
      throw new ArchiveValidationError(`${field} must be a non-empty string`);
    }
  }
}

async function digestHex(value, cryptoImpl) {
  if (!cryptoImpl?.subtle) {
    throw new ArchiveConfigurationError("Web Crypto is required to hash archived events");
  }

  const bytes = new TextEncoder().encode(value);
  const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class ArchiveValidationError extends Error {}
export class ArchiveConfigurationError extends Error {}
export class EventIdConflictError extends Error {}

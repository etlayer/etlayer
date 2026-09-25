import { readDeliveryState, recordDeliveryState } from "./delivery-state.js";
import {
  nextDeliveryAttemptNumber,
  recordDeliveryAttempt,
} from "./delivery-attempt.js";
import { exportToPostHog } from "./posthog.js";
import { exportToStatsig } from "./statsig.js";
import { projectConfiguration, resolveProjectDestinations, validateProjectId } from "./project-config.js";
import { resolveDestinationCredential } from "./destination-credentials.js";
import { projectIdForEvent, scopedProjectKey } from "./project-scope.js";

const DESTINATION_EXPORTERS = {
  posthog: exportToPostHog,
  statsig: exportToStatsig,
};

const DEFAULT_MAX_EVENTS = 500;
const HARD_MAX_EVENTS = 5000;
const LIST_PAGE_SIZE = 1000;

export async function replayPostHogRange(env, input, options = {}) {
  return replayDestinationRange(env, input, "posthog", options);
}

export async function replayStatsigRange(env, input, options = {}) {
  return replayDestinationRange(env, input, "statsig", options);
}

export async function replayDestinationRange(
  env,
  input,
  destination,
  options = {},
) {
  if (
    !env.ARCHIVE ||
    typeof env.ARCHIVE.list !== "function" ||
    typeof env.ARCHIVE.get !== "function"
  ) {
    throw new ReplayConfigurationError(
      "archive bucket is not configured for replay",
    );
  }

  const range = normalizeReplayRange(input);

  const enabledDestinations =
    await resolveProjectDestinations(
      env.ARCHIVE,
      range.projectId,
    );

  if (!enabledDestinations.includes(destination)) {
    throw new ReplayValidationError(
      `destination ${destination} is not enabled for project ${range.projectId}`,
    );
  }

  const selected = await selectArchivedEvents(
    env.ARCHIVE,
    range,
    options,
  );
  const exporter = options.deliver
    ? (event, _env, exportOptions) =>
        options.deliver(event, exportOptions.delivery)
    : destinationExporter(destination);

  const readState = options.readState || readDeliveryState;
  const recordState = options.recordState || recordDeliveryState;
  const recordAttempt =
    options.recordAttempt || recordDeliveryAttempt;
  const credential =
    !options.deliver &&
    !projectConfiguration(range.projectId)
      ? await resolveDestinationCredential(
          env.ARCHIVE,
          env,
          range.projectId,
          destination,
          { crypto: options.crypto },
        )
      : null;
  const deliveries = [];
  let exported = 0;
  let skipped = 0;

  for (const item of selected) {
    const delivery = {
      mode: "replay",
      replayId: range.replayId,
      sourceKey: item.key,
      destination,
    };

    const previous = await readState(
      env.ARCHIVE,
      item.event.id,
      destination,
      { projectId: range.projectId },
    );

    if (previous?.status === "exported") {
      deliveries.push({
        eventId: item.event.id,
        eventName: item.event.eventName,
        destination,
        sourceKey: item.key,
        status: "skipped",
        reason: "already_exported",
      });
      skipped += 1;
      continue;
    }

    const attemptNumber =
      options.nextAttemptNumber
        ? await options.nextAttemptNumber(
            env.ARCHIVE,
            item.event.id,
            destination,
            {
              projectId: range.projectId,
              previousState: previous,
            },
          )
        : await nextDeliveryAttemptNumber(
            env.ARCHIVE,
            item.event.id,
            destination,
            {
              projectId: range.projectId,
              previousState: previous,
            },
          );

    const startedAt = replayTimestamp(options.now);
    const exportOptions = {
      fetch: options.fetch,
      crypto: options.crypto,
      delivery,
      ...(
        credential
          ? { credential: credential.secret }
          : {}
      ),
    };

    let result;
    try {
      result = await exporter(
        item.event,
        env,
        exportOptions,
      );
    } catch (error) {
      result = {
        status: "failed",
        error,
      };
    }

    const shouldRecord =
      Boolean(options.recordState) ||
      typeof env.ARCHIVE.put === "function";
    let attempt = null;

    if (shouldRecord) {
      attempt = await recordAttempt(
        env.ARCHIVE,
        item.event,
        destination,
        result,
        {
          attemptNumber,
          startedAt,
          completedAt: replayTimestamp(options.now),
          delivery,
          crypto: options.crypto,
        },
      );

      await recordState(
        env.ARCHIVE,
        item.event,
        destination,
        result,
        {
          now: options.now,
          delivery,
          attempt: attempt.state,
        },
      );
    }

    if (!result || result.status !== "exported") {
      throw new ReplayConfigurationError(
        `${destination} did not export replayed event ${item.event.id}`,
      );
    }

    deliveries.push({
      eventId: item.event.id,
      eventName: item.event.eventName,
      destination,
      sourceKey: item.key,
      status: result.status,
      ...(result.uuid ? { uuid: result.uuid } : {}),
      ...(attempt
        ? {
            deliveryId: attempt.state.deliveryId,
            attemptId: attempt.state.attemptId,
            attemptNumber: attempt.state.attemptNumber,
          }
        : {}),
    });
    exported += 1;
  }

  return {
    projectId: range.projectId,
    destination,
    replayId: range.replayId,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    selected: selected.length,
    exported,
    skipped,
    deliveries,
  };
}

function replayTimestamp(value) {
  const date =
    value instanceof Date
      ? value
      : new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new ReplayConfigurationError(
      "replay delivery timestamp is invalid",
    );
  }

  return date;
}

function destinationExporter(destination) {
  const exporter = DESTINATION_EXPORTERS[destination];

  if (!exporter) {
    throw new ReplayValidationError(
      `unsupported replay destination: ${String(destination)}`,
    );
  }

  return exporter;
}

export async function selectArchivedEvents(archive, input, options = {}) {
  const range = input.from instanceof Date ? input : normalizeReplayRange(input);
  const maxEvents = normalizeMaxEvents(input.maxEvents);
  const selected = [];

  for (const prefix of hourlyPrefixes(
    range.from,
    range.to,
    range.projectId,
  )) {
    let cursor;

    do {
      const page = await archive.list({
        prefix,
        cursor,
        limit: options.listPageSize || LIST_PAGE_SIZE,
      });

      for (const object of page.objects || []) {
        const archived = await archive.get(object.key);
        if (!archived) {
          throw new ReplayArchiveError(`archive object disappeared during replay: ${object.key}`);
        }

        const event = await readArchivedEvent(
          archived,
          object.key,
        );

        if (projectIdForEvent(event) !== range.projectId) {
          throw new ReplayArchiveError(
            `archive object project does not match requested project: ${object.key}`,
          );
        }

        const receivedAt = new Date(event.receivedAt);

        if (
          receivedAt.getTime() >= range.from.getTime() &&
          receivedAt.getTime() < range.to.getTime() &&
          (
            !options.filterEvent ||
            options.filterEvent(event, object.key)
          )
        ) {
          selected.push({ key: object.key, event });

          if (selected.length > maxEvents) {
            throw new ReplayLimitError(
              `replay selection exceeds maxEvents=${maxEvents}; narrow the time range or raise the limit`,
            );
          }
        }
      }

      cursor = page.truncated && page.cursor ? page.cursor : undefined;
    } while (cursor);
  }

  selected.sort((left, right) => {
    const time =
      new Date(left.event.receivedAt).getTime() -
      new Date(right.event.receivedAt).getTime();

    if (time !== 0) return time;
    return left.event.id.localeCompare(right.event.id);
  });

  return selected;
}

export function normalizeReplayRange(input = {}) {
  const projectId = normalizeProjectId(input.projectId);
  const from = parseDate(input.from, "from");
  const to = parseDate(input.to, "to");

  if (from.getTime() >= to.getTime()) {
    throw new ReplayValidationError("from must be earlier than to");
  }

  const replayId =
    typeof input.replayId === "string" && input.replayId.trim() !== ""
      ? input.replayId
      : crypto.randomUUID();

  return {
    projectId,
    from,
    to,
    replayId,
    maxEvents: normalizeMaxEvents(input.maxEvents),
  };
}

function normalizeMaxEvents(value) {
  if (value == null) return DEFAULT_MAX_EVENTS;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > HARD_MAX_EVENTS) {
    throw new ReplayValidationError(
      `maxEvents must be an integer between 1 and ${HARD_MAX_EVENTS}`,
    );
  }

  return parsed;
}

function normalizeProjectId(value) {
  try {
    return validateProjectId(value);
  } catch {
    throw new ReplayValidationError(
      "projectId must be a valid project slug",
    );
  }
}

function parseDate(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReplayValidationError(`${name} must be an ISO timestamp string`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ReplayValidationError(`${name} must be a valid ISO timestamp`);
  }

  return date;
}

function* hourlyPrefixes(from, to, projectId) {
  const cursor = new Date(from);
  cursor.setUTCMinutes(0, 0, 0);

  const finalInstant = new Date(to.getTime() - 1);
  finalInstant.setUTCMinutes(0, 0, 0);

  while (cursor.getTime() <= finalInstant.getTime()) {
    const yyyy = String(cursor.getUTCFullYear()).padStart(4, "0");
    const mm = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(cursor.getUTCDate()).padStart(2, "0");
    const hh = String(cursor.getUTCHours()).padStart(2, "0");

    yield scopedProjectKey(
      projectId,
      `events/${yyyy}/${mm}/${dd}/${hh}/`,
    );
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
}

async function readArchivedEvent(object, key) {
  let text;

  if (typeof object.text === "function") {
    text = await object.text();
  } else if (object.body != null) {
    text = await new Response(object.body).text();
  } else {
    throw new ReplayArchiveError(`archive object has no readable body: ${key}`);
  }

  let event;
  try {
    event = JSON.parse(text);
  } catch {
    throw new ReplayArchiveError(`archive object is not valid JSON: ${key}`);
  }

  if (
    !event ||
    typeof event.id !== "string" ||
    typeof event.eventName !== "string" ||
    typeof event.receivedAt !== "string"
  ) {
    throw new ReplayArchiveError(`archive object is not a managed ETLayer event: ${key}`);
  }

  return event;
}

export class ReplayValidationError extends Error {}
export class ReplayLimitError extends ReplayValidationError {}
export class ReplayConfigurationError extends Error {}
export class ReplayArchiveError extends Error {}

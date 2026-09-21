import { recordDeliveryState } from "./delivery-state.js";
import { exportToPostHog } from "./posthog.js";
import { exportToStatsig } from "./statsig.js";

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
  const selected = await selectArchivedEvents(env.ARCHIVE, range, options);
  const exporter =
    options.deliver || destinationExporter(destination);

  const recordState = options.recordState || recordDeliveryState;
  const deliveries = [];

  for (const item of selected) {
    const delivery = {
      mode: "replay",
      replayId: range.replayId,
      sourceKey: item.key,
      destination,
    };

    const result = await exporter(item.event, env, {
      fetch: options.fetch,
      crypto: options.crypto,
      delivery,
    });

    if (!result || result.status !== "exported") {
      throw new ReplayConfigurationError(
        `${destination} did not export replayed event ${item.event.id}`,
      );
    }

    if (
      options.recordState ||
      typeof env.ARCHIVE.put === "function"
    ) {
      await recordState(
        env.ARCHIVE,
        item.event,
        destination,
        result,
        { delivery },
      );
    }

    deliveries.push({
      eventId: item.event.id,
      eventName: item.event.eventName,
      destination,
      sourceKey: item.key,
      status: result.status,
      ...(result.uuid ? { uuid: result.uuid } : {}),
    });
  }

  return {
    destination,
    replayId: range.replayId,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    selected: selected.length,
    exported: deliveries.length,
    deliveries,
  };
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

  for (const prefix of hourlyPrefixes(range.from, range.to)) {
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

        const event = await readArchivedEvent(archived, object.key);
        const receivedAt = new Date(event.receivedAt);

        if (
          receivedAt.getTime() >= range.from.getTime() &&
          receivedAt.getTime() < range.to.getTime()
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

function* hourlyPrefixes(from, to) {
  const cursor = new Date(from);
  cursor.setUTCMinutes(0, 0, 0);

  const finalInstant = new Date(to.getTime() - 1);
  finalInstant.setUTCMinutes(0, 0, 0);

  while (cursor.getTime() <= finalInstant.getTime()) {
    const yyyy = String(cursor.getUTCFullYear()).padStart(4, "0");
    const mm = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(cursor.getUTCDate()).padStart(2, "0");
    const hh = String(cursor.getUTCHours()).padStart(2, "0");

    yield `events/${yyyy}/${mm}/${dd}/${hh}/`;
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

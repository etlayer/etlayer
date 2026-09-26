import {
  readContractLifecycle,
} from "./contract-lifecycle.js";
import {
  readContractOwnership,
} from "./contract-ownership.js";
import {
  inspectEventState,
} from "./event-inspection.js";
import {
  selectArchivedEvents,
} from "./replay.js";
import {
  validateProjectId,
} from "./project-config.js";

export const GOVERNANCE_METRICS_VERSION = 1;

const DEFAULT_MAX_EVENTS = 500;
const HARD_MAX_EVENTS = 5000;
const MAX_GOVERNANCE_RESOURCES = 5000;
const LIST_PAGE_SIZE = 1000;

export async function buildGovernanceMetrics(
  env,
  input,
  options = {},
) {
  if (
    !env?.ARCHIVE ||
    typeof env.ARCHIVE.list !== "function" ||
    typeof env.ARCHIVE.get !== "function"
  ) {
    throw new GovernanceMetricsConfigurationError(
      "archive bucket is not configured for governance metrics",
    );
  }

  const range = normalizeGovernanceMetricsInput(input);
  const selectEvents =
    options.selectEvents ||
    selectArchivedEvents;
  const inspect =
    options.inspectEvent ||
    inspectEventState;

  const selected = await selectEvents(
    env.ARCHIVE,
    {
      projectId: range.projectId,
      from: range.from,
      to: range.to,
      maxEvents: range.maxEvents,
    },
    {
      listPageSize:
        options.listPageSize,
      filterEvent(event) {
        return (
          !range.eventName ||
          event.eventName ===
            range.eventName
        );
      },
    },
  );

  const eventMetrics =
    emptyEventMetrics();

  for (const item of selected) {
    const inspected = await inspect(
      env.ARCHIVE,
      range.projectId,
      item.event.id,
    );

    accumulateEventMetrics(
      eventMetrics,
      inspected,
    );
  }

  finalizeEventMetrics(
    eventMetrics,
    selected.length,
  );

  const governance =
    await buildCurrentGovernanceInventory(
      env.ARCHIVE,
      range.projectId,
      options,
    );

  return {
    version:
      GOVERNANCE_METRICS_VERSION,
    projectId:
      range.projectId,
    scope: {
      from:
        range.from.toISOString(),
      to:
        range.to.toISOString(),
      maxEvents:
        range.maxEvents,
      eventName:
        range.eventName,
    },
    eventWindow: {
      selected:
        selected.length,
      ...eventMetrics,
    },
    currentGovernance:
      governance,
  };
}

export function normalizeGovernanceMetricsInput(
  input = {},
) {
  let projectId;

  try {
    projectId =
      validateProjectId(
        input.projectId,
      );
  } catch {
    throw new GovernanceMetricsValidationError(
      "projectId must be a valid project slug",
    );
  }

  const from = parseDate(
    input.from,
    "from",
  );
  const to = parseDate(
    input.to,
    "to",
  );

  if (
    from.getTime() >= to.getTime()
  ) {
    throw new GovernanceMetricsValidationError(
      "from must be earlier than to",
    );
  }

  const maxEvents =
    normalizeBoundedInteger(
      input.maxEvents,
      DEFAULT_MAX_EVENTS,
      1,
      HARD_MAX_EVENTS,
      "maxEvents",
    );

  let eventName = null;

  if (
    input.eventName != null &&
    input.eventName !== ""
  ) {
    if (
      typeof input.eventName !==
        "string" ||
      input.eventName.trim() === ""
    ) {
      throw new GovernanceMetricsValidationError(
        "eventName must be a non-empty string",
      );
    }

    eventName =
      input.eventName.trim();
  }

  return {
    projectId,
    from,
    to,
    maxEvents,
    eventName,
  };
}

async function buildCurrentGovernanceInventory(
  archive,
  projectId,
  options,
) {
  const ownerships =
    await listCurrentOwnerships(
      archive,
      projectId,
      options,
    );
  const lifecycles =
    await listCurrentLifecycles(
      archive,
      projectId,
      options,
    );
  const teams = [
    ...new Set(
      ownerships.map(
        (ownership) =>
          ownership.team,
      ),
    ),
  ].sort();

  const lifecycle = {
    total: lifecycles.length,
    published: 0,
    deprecated: 0,
    retired: 0,
  };

  for (const state of lifecycles) {
    if (
      Object.hasOwn(
        lifecycle,
        state.status,
      )
    ) {
      lifecycle[state.status] += 1;
    }
  }

  return {
    ownership: {
      resources:
        ownerships.length,
      teams,
      teamCount:
        teams.length,
    },
    lifecycle,
  };
}

async function listCurrentOwnerships(
  archive,
  projectId,
  options,
) {
  const prefix =
    governancePrefix(
      projectId,
      "ownership",
    );
  const keys =
    await listBoundedKeys(
      archive,
      prefix,
      options,
    );
  const result = [];

  for (const key of keys) {
    const encoded =
      key
        .slice(prefix.length)
        .replace(/\.json$/, "");

    if (
      encoded === "" ||
      key.slice(prefix.length)
        .includes("/")
    ) {
      continue;
    }

    const eventName =
      decodeURIComponent(encoded);
    const state =
      await readContractOwnership(
        archive,
        projectId,
        eventName,
      );

    if (state) {
      result.push(state);
    }
  }

  result.sort((left, right) =>
    left.eventName.localeCompare(
      right.eventName,
    ),
  );

  return result;
}

async function listCurrentLifecycles(
  archive,
  projectId,
  options,
) {
  const prefix =
    governancePrefix(
      projectId,
      "contract-lifecycle",
    );
  const keys =
    await listBoundedKeys(
      archive,
      prefix,
      options,
    );
  const result = [];

  for (const key of keys) {
    const relative =
      key.slice(prefix.length);
    const match =
      relative.match(
        /^([^/]+)\/(\d+)\.json$/,
      );

    if (!match) continue;

    const eventName =
      decodeURIComponent(match[1]);
    const version =
      Number(match[2]);

    if (
      !Number.isSafeInteger(
        version,
      ) ||
      version < 1
    ) {
      continue;
    }

    const state =
      await readContractLifecycle(
        archive,
        projectId,
        eventName,
        version,
      );

    if (state) {
      result.push(state);
    }
  }

  result.sort((left, right) => {
    const eventName =
      left.eventName.localeCompare(
        right.eventName,
      );

    if (eventName !== 0) {
      return eventName;
    }

    return (
      left.contractVersion -
      right.contractVersion
    );
  });

  return result;
}

async function listBoundedKeys(
  archive,
  prefix,
  options,
) {
  const keys = [];
  let cursor;

  do {
    const page = await archive.list({
      prefix,
      cursor,
      limit:
        options.listPageSize ||
        LIST_PAGE_SIZE,
    });

    for (
      const object of
      page.objects || []
    ) {
      keys.push(object.key);

      if (
        keys.length >
        MAX_GOVERNANCE_RESOURCES
      ) {
        throw new GovernanceMetricsLimitError(
          `governance inventory exceeds ${MAX_GOVERNANCE_RESOURCES} resources`,
        );
      }
    }

    cursor =
      page.truncated && page.cursor
        ? page.cursor
        : undefined;
  } while (cursor);

  keys.sort();

  return keys;
}

function accumulateEventMetrics(
  metrics,
  inspected,
) {
  incrementStatus(
    metrics.validation,
    inspected.validation?.status,
  );
  incrementStatus(
    metrics.decisions,
    inspected.decision?.outcome,
  );

  if (inspected.ownership) {
    metrics.ownership.owned += 1;

    if (
      typeof inspected.ownership
        .team === "string"
    ) {
      metrics.ownership._teams.add(
        inspected.ownership.team,
      );
    }
  } else {
    metrics.ownership.unowned += 1;
  }

  for (
    const delivery of
    inspected.deliveries || []
  ) {
    metrics.delivery.summaries.total += 1;

    const status =
      delivery.status;

    if (
      Object.hasOwn(
        metrics.delivery.summaries,
        status,
      )
    ) {
      metrics.delivery.summaries[
        status
      ] += 1;
    } else {
      metrics.delivery.summaries.unknown += 1;
    }

    for (
      const attempt of
      delivery.attempts || []
    ) {
      metrics.delivery.attempts.total += 1;

      if (
        Object.hasOwn(
          metrics.delivery.attempts,
          attempt.status,
        )
      ) {
        metrics.delivery.attempts[
          attempt.status
        ] += 1;
      } else {
        metrics.delivery.attempts.unknown += 1;
      }
    }
  }
}

function finalizeEventMetrics(
  metrics,
  selected,
) {
  metrics.validation.validRate =
    rate(
      metrics.validation.valid,
      selected,
    );
  metrics.validation.quarantineRate =
    rate(
      metrics.validation.quarantined,
      selected,
    );

  metrics.decisions.allowRate =
    rate(
      metrics.decisions.allow,
      selected,
    );
  metrics.decisions.blockRate =
    rate(
      metrics.decisions.block,
      selected,
    );
  metrics.decisions.quarantineRate =
    rate(
      metrics.decisions.quarantine,
      selected,
    );

  metrics.ownership.coverageRate =
    rate(
      metrics.ownership.owned,
      selected,
    );
  metrics.ownership.teams = [
    ...metrics.ownership._teams,
  ].sort();
  metrics.ownership.teamCount =
    metrics.ownership.teams.length;
  delete metrics.ownership._teams;

  metrics.delivery.summaries.exportedRate =
    rate(
      metrics.delivery.summaries.exported,
      metrics.delivery.summaries.total,
    );
  metrics.delivery.attempts.exportedRate =
    rate(
      metrics.delivery.attempts.exported,
      metrics.delivery.attempts.total,
    );
}

function emptyEventMetrics() {
  return {
    validation: {
      valid: 0,
      quarantined: 0,
      blocked: 0,
      unknown: 0,
      validRate: 0,
      quarantineRate: 0,
    },
    decisions: {
      allow: 0,
      block: 0,
      quarantine: 0,
      unknown: 0,
      allowRate: 0,
      blockRate: 0,
      quarantineRate: 0,
    },
    ownership: {
      owned: 0,
      unowned: 0,
      coverageRate: 0,
      teamCount: 0,
      teams: [],
      _teams: new Set(),
    },
    delivery: {
      summaries: {
        total: 0,
        exported: 0,
        skipped: 0,
        failed: 0,
        not_routed: 0,
        pending: 0,
        unknown: 0,
        exportedRate: 0,
      },
      attempts: {
        total: 0,
        exported: 0,
        skipped: 0,
        failed: 0,
        unknown: 0,
        exportedRate: 0,
      },
    },
  };
}

function incrementStatus(
  target,
  status,
) {
  if (
    typeof status === "string" &&
    Object.hasOwn(target, status)
  ) {
    target[status] += 1;
    return;
  }

  target.unknown += 1;
}

function governancePrefix(
  projectId,
  resource,
) {
  return (
    "registry/governance/" +
    encodeURIComponent(projectId) +
    "/" +
    resource +
    "/"
  );
}

function rate(
  numerator,
  denominator,
) {
  if (!denominator) return 0;

  return Number(
    (
      numerator /
      denominator
    ).toFixed(6),
  );
}

function normalizeBoundedInteger(
  value,
  fallback,
  min,
  max,
  label,
) {
  const normalized =
    value == null
      ? fallback
      : Number(value);

  if (
    !Number.isSafeInteger(
      normalized,
    ) ||
    normalized < min ||
    normalized > max
  ) {
    throw new GovernanceMetricsValidationError(
      `${label} must be an integer between ${min} and ${max}`,
    );
  }

  return normalized;
}

function parseDate(
  value,
  label,
) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new GovernanceMetricsValidationError(
      `${label} must be an ISO timestamp string`,
    );
  }

  const date = new Date(value);

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    throw new GovernanceMetricsValidationError(
      `${label} must be a valid ISO timestamp`,
    );
  }

  return date;
}

export class GovernanceMetricsValidationError extends Error {}
export class GovernanceMetricsLimitError extends Error {}
export class GovernanceMetricsConfigurationError extends Error {}

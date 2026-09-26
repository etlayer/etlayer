import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureContractLifecycle,
  transitionContractLifecycle,
} from "../src/contract-lifecycle.js";
import {
  writeContractOwnership,
} from "../src/contract-ownership.js";
import {
  buildGovernanceMetrics,
} from "../src/governance-metrics.js";

function archive() {
  const objects = new Map();

  return {
    objects,
    async put(key, body, options = {}) {
      if (
        options.onlyIf?.etagDoesNotMatch === "*" &&
        objects.has(key)
      ) {
        return null;
      }

      objects.set(key, {
        body,
        customMetadata:
          options.customMetadata || {},
      });

      return { key };
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;

      return {
        async text() {
          return stored.body;
        },
      };
    },
    async list({
      prefix = "",
      cursor,
      limit = 1000,
    } = {}) {
      const keys = [...objects.keys()]
        .filter((key) =>
          key.startsWith(prefix),
        )
        .sort();

      const offset =
        cursor == null
          ? 0
          : Number(cursor);
      const page =
        keys.slice(
          offset,
          offset + limit,
        );
      const next =
        offset + page.length;

      return {
        objects:
          page.map(
            (key) => ({ key }),
          ),
        truncated:
          next < keys.length,
        cursor:
          next < keys.length
            ? String(next)
            : undefined,
      };
    },
  };
}

async function seedGovernance(
  store,
) {
  await writeContractOwnership(
    store,
    {
      projectId: "project-a",
      eventName:
        "account.created",
      team: "accounts-platform",
      domain: "accounts",
      contacts: [],
    },
    {
      now: new Date(
        "2026-09-26T10:00:00Z",
      ),
    },
  );

  await ensureContractLifecycle(
    store,
    {
      projectId: "project-a",
      eventName:
        "account.created",
      contractVersion: 2,
      contractId:
        "account.created@2",
      manifestDigest:
        "a".repeat(64),
      publishedAt:
        "2026-09-26T10:00:00Z",
    },
  );

  await transitionContractLifecycle(
    store,
    {
      projectId: "project-a",
      eventName:
        "account.created",
      contractVersion: 2,
      contractId:
        "account.created@2",
      manifestDigest:
        "a".repeat(64),
      publishedAt:
        "2026-09-26T10:00:00Z",
      toStatus: "deprecated",
    },
    {
      now: new Date(
        "2026-09-26T10:05:00Z",
      ),
    },
  );
}

test("aggregates bounded event evidence and current governance inventory", async () => {
  const store = archive();

  await seedGovernance(store);

  const inspections = {
    "evt-allow": {
      validation: {
        status: "valid",
      },
      decision: {
        outcome: "allow",
      },
      ownership: {
        team: "accounts-platform",
      },
      deliveries: [
        {
          status: "exported",
          attempts: [
            {
              status: "exported",
            },
            {
              status: "failed",
            },
          ],
        },
      ],
    },
    "evt-quarantine": {
      validation: {
        status: "quarantined",
      },
      decision: {
        outcome: "quarantine",
      },
      ownership: null,
      deliveries: [
        {
          status: "not_routed",
          attempts: [],
        },
      ],
    },
  };

  const result =
    await buildGovernanceMetrics(
      { ARCHIVE: store },
      {
        projectId: "project-a",
        from:
          "2026-09-26T10:00:00Z",
        to:
          "2026-09-26T11:00:00Z",
        maxEvents: 10,
      },
      {
        async selectEvents() {
          return [
            {
              event: {
                id: "evt-allow",
                eventName:
                  "account.created",
              },
            },
            {
              event: {
                id: "evt-quarantine",
                eventName:
                  "account.created",
              },
            },
          ];
        },
        async inspectEvent(
          _archive,
          _projectId,
          eventId,
        ) {
          return inspections[eventId];
        },
      },
    );

  assert.equal(result.version, 1);
  assert.equal(
    result.eventWindow.selected,
    2,
  );
  assert.deepEqual(
    result.eventWindow.validation,
    {
      valid: 1,
      quarantined: 1,
      blocked: 0,
      unknown: 0,
      validRate: 0.5,
      quarantineRate: 0.5,
    },
  );
  assert.deepEqual(
    result.eventWindow.decisions,
    {
      allow: 1,
      block: 0,
      quarantine: 1,
      unknown: 0,
      allowRate: 0.5,
      blockRate: 0,
      quarantineRate: 0.5,
    },
  );
  assert.deepEqual(
    result.eventWindow.ownership,
    {
      owned: 1,
      unowned: 1,
      coverageRate: 0.5,
      teamCount: 1,
      teams: [
        "accounts-platform",
      ],
    },
  );
  assert.equal(
    result.eventWindow.delivery
      .summaries.total,
    2,
  );
  assert.equal(
    result.eventWindow.delivery
      .summaries.exported,
    1,
  );
  assert.equal(
    result.eventWindow.delivery
      .summaries.not_routed,
    1,
  );
  assert.equal(
    result.eventWindow.delivery
      .summaries.exportedRate,
    0.5,
  );
  assert.equal(
    result.eventWindow.delivery
      .attempts.total,
    2,
  );
  assert.equal(
    result.eventWindow.delivery
      .attempts.exported,
    1,
  );
  assert.equal(
    result.eventWindow.delivery
      .attempts.failed,
    1,
  );
  assert.equal(
    result.eventWindow.delivery
      .attempts.exportedRate,
    0.5,
  );

  assert.deepEqual(
    result.currentGovernance,
    {
      ownership: {
        resources: 1,
        teams: [
          "accounts-platform",
        ],
        teamCount: 1,
      },
      lifecycle: {
        total: 1,
        published: 0,
        deprecated: 1,
        retired: 0,
      },
    },
  );
});

test("empty event window returns zero rates without changing current inventory", async () => {
  const store = archive();

  await seedGovernance(store);

  const result =
    await buildGovernanceMetrics(
      { ARCHIVE: store },
      {
        projectId: "project-a",
        from:
          "2026-09-26T12:00:00Z",
        to:
          "2026-09-26T13:00:00Z",
      },
      {
        async selectEvents() {
          return [];
        },
      },
    );

  assert.equal(
    result.eventWindow.selected,
    0,
  );
  assert.equal(
    result.eventWindow.validation
      .validRate,
    0,
  );
  assert.equal(
    result.eventWindow.decisions
      .allowRate,
    0,
  );
  assert.equal(
    result.eventWindow.ownership
      .coverageRate,
    0,
  );
  assert.equal(
    result.eventWindow.delivery
      .summaries.exportedRate,
    0,
  );
  assert.equal(
    result.eventWindow.delivery
      .attempts.exportedRate,
    0,
  );
  assert.equal(
    result.currentGovernance
      .ownership.resources,
    1,
  );
  assert.equal(
    result.currentGovernance
      .lifecycle.deprecated,
    1,
  );
});

test("passes optional eventName to bounded archive selection", async () => {
  const store = archive();
  let accepted = null;

  await buildGovernanceMetrics(
    { ARCHIVE: store },
    {
      projectId: "project-a",
      from:
        "2026-09-26T10:00:00Z",
      to:
        "2026-09-26T11:00:00Z",
      eventName:
        "account.created",
    },
    {
      async selectEvents(
        _archive,
        _input,
        options,
      ) {
        accepted = [
          options.filterEvent({
            eventName:
              "account.created",
          }),
          options.filterEvent({
            eventName:
              "landing.hero.exposed",
          }),
        ];

        return [];
      },
    },
  );

  assert.deepEqual(
    accepted,
    [true, false],
  );
});

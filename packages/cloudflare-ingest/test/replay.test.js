import assert from "node:assert/strict";
import test from "node:test";

import { archiveKey } from "../src/archive.js";
import { projectToPostHog } from "../src/posthog.js";
import {
  replayPostHogRange,
  ReplayLimitError,
  selectArchivedEvents,
} from "../src/replay.js";

function event(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    eventName: "etlayer.acceptance.smoke",
    occurredAtUnixNano: "1790015799803000000",
    observedAtUnixNano: "1790015799803000000",
    receivedAt: "2026-09-21T18:36:39.955Z",
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "etlayer-smoke" } },
      ],
    },
    scope: { name: "etlayer.smoke", version: "0.1.0" },
    logRecord: {
      eventName: "etlayer.acceptance.smoke",
      attributes: [
        { key: "user.id", value: { stringValue: "smoke-user" } },
        {
          key: "etlayer.event.id",
          value: { stringValue: "11111111-1111-4111-8111-111111111111" },
        },
      ],
    },
    ...overrides,
  };
}

function fakeArchive(events) {
  const objects = new Map(
    events.map((managedEvent) => [
      archiveKey(managedEvent),
      JSON.stringify(managedEvent),
    ]),
  );

  return {
    async list({ prefix }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((key) => ({ key })),
        truncated: false,
      };
    },
    async get(key) {
      const body = objects.get(key);
      if (body == null) return null;
      return {
        async text() {
          return body;
        },
      };
    },
  };
}

test("selects archived events by received-at range in deterministic order", async () => {
  const later = event({
    id: "22222222-2222-4222-8222-222222222222",
    receivedAt: "2026-09-21T18:44:42.857Z",
  });
  const earlier = event();
  const outside = event({
    id: "33333333-3333-4333-8333-333333333333",
    receivedAt: "2026-09-21T18:55:00.000Z",
  });

  const selected = await selectArchivedEvents(
    fakeArchive([later, outside, earlier]),
    {
      from: "2026-09-21T18:35:00.000Z",
      to: "2026-09-21T18:45:00.000Z",
      replayId: "replay-1",
    },
  );

  assert.deepEqual(
    selected.map(({ event: managedEvent }) => managedEvent.id),
    [earlier.id, later.id],
  );
});

test("replays canonical events with original identity and occurrence time", async () => {
  const managedEvent = event();
  const archive = fakeArchive([managedEvent]);
  const captures = [];

  const result = await replayPostHogRange(
    {
      ARCHIVE: archive,
      POSTHOG_PROJECT_TOKEN: "phc_test",
    },
    {
      from: "2026-09-21T18:35:00.000Z",
      to: "2026-09-21T18:40:00.000Z",
      replayId: "replay-proof",
    },
    {
      deliver: async (archivedEvent, delivery) => {
        const payload = await projectToPostHog(archivedEvent, { delivery });
        captures.push(payload);
        return {
          status: "exported",
          eventId: archivedEvent.id,
          uuid: payload.uuid,
        };
      },
    },
  );

  assert.equal(result.selected, 1);
  assert.equal(result.exported, 1);
  assert.equal(captures[0].uuid, managedEvent.id);
  assert.equal(captures[0].event, managedEvent.eventName);
  assert.equal(
    captures[0].timestamp,
    new Date(Number(BigInt(managedEvent.occurredAtUnixNano) / 1_000_000n)).toISOString(),
  );
  assert.equal(captures[0].properties["etlayer.delivery.mode"], "replay");
  assert.equal(captures[0].properties["etlayer.replay.id"], "replay-proof");
  assert.equal(
    captures[0].properties["etlayer.event.id"],
    managedEvent.id,
  );
});

test("retrying the same replay keeps the same PostHog UUID", async () => {
  const managedEvent = event();
  const archive = fakeArchive([managedEvent]);
  const uuids = [];

  const options = {
    deliver: async (archivedEvent, delivery) => {
      const payload = await projectToPostHog(archivedEvent, { delivery });
      uuids.push(payload.uuid);
      return { status: "exported", uuid: payload.uuid };
    },
  };

  const input = {
    from: "2026-09-21T18:35:00.000Z",
    to: "2026-09-21T18:40:00.000Z",
    replayId: "replay-retry",
  };

  await replayPostHogRange({ ARCHIVE: archive }, input, options);
  await replayPostHogRange({ ARCHIVE: archive }, input, options);

  assert.deepEqual(uuids, [managedEvent.id, managedEvent.id]);
});

test("fails instead of silently truncating a replay range", async () => {
  const archive = fakeArchive([
    event(),
    event({
      id: "22222222-2222-4222-8222-222222222222",
      receivedAt: "2026-09-21T18:37:00.000Z",
    }),
  ]);

  await assert.rejects(
    () =>
      selectArchivedEvents(archive, {
        from: "2026-09-21T18:35:00.000Z",
        to: "2026-09-21T18:40:00.000Z",
        maxEvents: 1,
      }),
    ReplayLimitError,
  );
});

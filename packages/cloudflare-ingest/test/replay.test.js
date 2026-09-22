import assert from "node:assert/strict";
import test from "node:test";

import { archiveKey } from "../src/archive.js";
import { projectToPostHog } from "../src/posthog.js";
import {
  replayPostHogRange,
  replayStatsigRange,
  ReplayLimitError,
  ReplayValidationError,
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
      projectId: "etlayer-default",
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
      projectId: "etlayer-default",
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
    projectId: "etlayer-default",
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
        projectId: "etlayer-default",
        from: "2026-09-21T18:35:00.000Z",
        to: "2026-09-21T18:40:00.000Z",
        maxEvents: 1,
      }),
    ReplayLimitError,
  );
});


test("Statsig-targeted replay calls Statsig only", async () => {
  const managedEvent = event();
  const archive = fakeArchive([managedEvent]);
  const requests = [];

  const result = await replayStatsigRange(
    {
      ARCHIVE: archive,
      STATSIG_SERVER_SECRET: "secret-test",
      STATSIG_HOST: "https://api.statsig.test",
    },
    {
      projectId: "etlayer-default",
      from: "2026-09-21T18:35:00.000Z",
      to: "2026-09-21T18:40:00.000Z",
      replayId: "replay-statsig-only",
    },
    {
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response('{"success":true}', { status: 202 });
      },
    },
  );

  assert.equal(result.destination, "statsig");
  assert.equal(result.selected, 1);
  assert.equal(result.exported, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.statsig.test/v1/log_event");

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.events.length, 1);
  assert.equal(
    body.events[0].metadata["etlayer.delivery.mode"],
    "replay",
  );
  assert.equal(
    body.events[0].metadata["etlayer.replay.id"],
    "replay-statsig-only",
  );
});


test("repeating a Statsig replay does not send an already exported event again", async () => {
  const managedEvent = event();
  const canonicalKey = archiveKey(managedEvent);
  const objects = new Map([
    [canonicalKey, JSON.stringify(managedEvent)],
  ]);
  const requests = [];

  const archive = {
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
    async put(key, body) {
      objects.set(key, body);
    },
  };

  const env = {
    ARCHIVE: archive,
    STATSIG_SERVER_SECRET: "secret-test",
    STATSIG_HOST: "https://api.statsig.test",
  };
  const input = {
    projectId: "etlayer-default",
    from: "2026-09-21T18:35:00.000Z",
    to: "2026-09-21T18:40:00.000Z",
    replayId: "replay-statsig-idempotent",
  };
  const options = {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response('{"success":true}', { status: 202 });
    },
  };

  const first = await replayStatsigRange(env, input, options);
  const second = await replayStatsigRange(env, input, options);

  assert.equal(first.exported, 1);
  assert.equal(first.skipped, 0);
  assert.equal(second.exported, 0);
  assert.equal(second.skipped, 1);
  assert.equal(requests.length, 1);
  assert.equal(second.deliveries[0].status, "skipped");
  assert.equal(
    second.deliveries[0].reason,
    "already_exported",
  );
});


test("secondary project cannot replay Statsig because it is not enabled", async () => {
  let archiveRead = false;

  await assert.rejects(
    () =>
      replayStatsigRange(
        {
          ARCHIVE: {
            async list() {
              archiveRead = true;
              return { objects: [], truncated: false };
            },
            async get() {
              return null;
            },
          },
        },
        {
          projectId: "etlayer-secondary",
          from: "2026-09-21T18:35:00.000Z",
          to: "2026-09-21T18:40:00.000Z",
          replayId: "secondary-statsig",
        },
      ),
    ReplayValidationError,
  );

  assert.equal(archiveRead, false);
});

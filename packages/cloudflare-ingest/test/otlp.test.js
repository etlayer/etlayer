import assert from "node:assert/strict";
import test from "node:test";

import {
  handleExportLogs,
  normalizeExportLogsRequest,
} from "../src/otlp.js";

function eventPayload(overrides = {}) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "fixture" },
            },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "fixture.scope", version: "0.1.0" },
            logRecords: [
              {
                eventName: "landing.hero.exposed",
                timeUnixNano: "1000000000",
                observedTimeUnixNano: "1000000001",
                attributes: [
                  {
                    key: "etlayer.event.id",
                    value: { stringValue: "evt-existing" },
                  },
                  {
                    key: "experiment.variant",
                    value: { stringValue: "a" },
                  },
                ],
                ...overrides,
              },
            ],
          },
        ],
      },
    ],
  };
}

function requestFor(payload, headers = {}) {
  return new Request("https://events.test/v1/logs", {
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

function envWithQueue() {
  const batches = [];
  return {
    batches,
    env: {
      ETLAYER_INGEST_KEY: "test-key",
      ETLAYER_MAX_REQUEST_BYTES: "1048576",
      EVENTS: {
        async sendBatch(messages) {
          batches.push(messages);
        },
      },
    },
  };
}

test("normalizes an OTLP event without losing resource, scope, or log record fields", () => {
  const payload = eventPayload();
  const [event] = normalizeExportLogsRequest(payload, {
    receivedAt: "2026-09-21T15:00:00.000Z",
    idFactory: () => "generated-id",
  });

  assert.equal(event.id, "evt-existing");
  assert.equal(event.eventName, "landing.hero.exposed");
  assert.equal(event.receivedAt, "2026-09-21T15:00:00.000Z");
  assert.deepEqual(event.resource, payload.resourceLogs[0].resource);
  assert.deepEqual(event.scope, payload.resourceLogs[0].scopeLogs[0].scope);
  assert.deepEqual(
    event.logRecord,
    payload.resourceLogs[0].scopeLogs[0].logRecords[0],
  );
});

test("generates an ETLayer event id when the producer does not supply one", () => {
  const payload = eventPayload({ attributes: [] });
  const [event] = normalizeExportLogsRequest(payload, {
    receivedAt: "2026-09-21T15:00:00.000Z",
    idFactory: () => "evt-generated",
  });

  assert.equal(event.id, "evt-generated");
});

test("accepts valid OTLP JSON, enqueues it, and returns an OTLP success response", async () => {
  const { env, batches } = envWithQueue();
  const response = await handleExportLogs(requestFor(eventPayload()), env, {
    receivedAt: "2026-09-21T15:00:00.000Z",
    idFactory: () => "evt-generated",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[0][0].body.id, "evt-existing");
  assert.equal(batches[0][0].body.eventName, "landing.hero.exposed");
});

test("rejects a request with an invalid bearer token", async () => {
  const { env, batches } = envWithQueue();
  const response = await handleExportLogs(
    requestFor(eventPayload(), { authorization: "Bearer wrong" }),
    env,
  );

  assert.equal(response.status, 401);
  assert.equal(batches.length, 0);
});

test("rejects non-JSON OTLP requests in the JSON-only VS1", async () => {
  const { env } = envWithQueue();
  const response = await handleExportLogs(
    requestFor(eventPayload(), { "content-type": "application/x-protobuf" }),
    env,
  );

  assert.equal(response.status, 415);
});

test("rejects log records that are not named events", async () => {
  const { env, batches } = envWithQueue();
  const response = await handleExportLogs(
    requestFor(eventPayload({ eventName: "" })),
    env,
  );

  assert.equal(response.status, 400);
  assert.equal(batches.length, 0);
});

test("rejects requests when the event queue is not configured", async () => {
  const response = await handleExportLogs(requestFor(eventPayload()), {
    ETLAYER_INGEST_KEY: "test-key",
  });

  assert.equal(response.status, 503);
});


test("scrubs secret fields before enqueue while preserving direct identifiers", async () => {
  const { env, batches } = envWithQueue();
  const payload = eventPayload({
    attributes: [
      {
        key: "etlayer.event.id",
        value: { stringValue: "evt-privacy" },
      },
      {
        key: "user.email",
        value: { stringValue: "person@example.test" },
      },
      {
        key: "auth.token",
        value: { stringValue: "do-not-store" },
      },
    ],
  });

  const response = await handleExportLogs(
    requestFor(payload),
    env,
    {
      receivedAt: "2026-09-22T01:00:00.000Z",
      idFactory: () => "generated",
    },
  );

  assert.equal(response.status, 200);
  const queued = batches[0][0].body;
  const keys = queued.logRecord.attributes.map(({ key }) => key);

  assert.equal(keys.includes("user.email"), true);
  assert.equal(keys.includes("auth.token"), false);
  assert.equal(JSON.stringify(queued).includes("do-not-store"), false);
  assert.deepEqual(queued.privacy.ingestActions, [
    {
      location: "logRecord",
      attribute: "auth.token",
      classification: "secret",
      action: "drop",
    },
  ]);
});

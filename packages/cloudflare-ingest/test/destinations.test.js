import assert from "node:assert/strict";
import test from "node:test";

import {
  DestinationRouterConfigurationError,
  routeEventDestinations,
} from "../src/destinations.js";
import {
  listDeliveryAttempts,
} from "../src/delivery-attempt.js";
import {
  createRegistryProject,
  credentialFingerprint,
  setRegistryDestination,
} from "../src/registry.js";
import { writeDestinationCredential } from "../src/destination-credentials.js";

test("routes an event through configured destinations in order", async () => {
  const calls = [];
  const states = [];
  const event = { id: "evt_1", eventName: "account.created" };
  const env = { example: true };

  const results = await routeEventDestinations(event, env, {
    destinations: [
      {
        name: "first",
        async exportEvent(receivedEvent, receivedEnv, options) {
          calls.push(["first", receivedEvent, receivedEnv, options]);
          return { status: "exported", deliveryId: "one" };
        },
      },
      {
        name: "second",
        async exportEvent(receivedEvent, receivedEnv, options) {
          calls.push(["second", receivedEvent, receivedEnv, options]);
          return { status: "skipped", reason: "not_configured" };
        },
      },
    ],
    first: { marker: 1 },
    second: { marker: 2 },
    async recordState(_archive, receivedEvent, destination, result) {
      states.push({ receivedEvent, destination, result });
    },
  });

  assert.deepEqual(
    calls.map(([name, , , options]) => [name, options]),
    [
      ["first", { marker: 1 }],
      ["second", { marker: 2 }],
    ],
  );
  assert.equal(calls[0][1], event);
  assert.equal(calls[0][2], env);
  assert.deepEqual(
    states.map(({ destination, result }) => [
      destination,
      result.status,
    ]),
    [
      ["first", "exported"],
      ["second", "skipped"],
    ],
  );
  assert.deepEqual(results, [
    {
      destination: "first",
      status: "exported",
      deliveryId: "one",
    },
    {
      destination: "second",
      status: "skipped",
      reason: "not_configured",
    },
  ]);
});

test("a failed destination does not prevent another destination from being attempted", async () => {
  const calls = [];
  const states = [];

  const results = await routeEventDestinations(
    { id: "evt_1", eventName: "account.created" },
    {},
    {
      destinations: [
        {
          name: "posthog",
          async exportEvent() {
            calls.push("posthog");
            const error = new Error("destination failed");
            error.status = 503;
            throw error;
          },
        },
        {
          name: "statsig",
          async exportEvent() {
            calls.push("statsig");
            return { status: "exported" };
          },
        },
      ],
      async recordState(_archive, _event, destination, result) {
        states.push([destination, result.status]);
      },
    },
  );

  assert.deepEqual(calls, ["posthog", "statsig"]);
  assert.deepEqual(states, [
    ["posthog", "failed"],
    ["statsig", "exported"],
  ]);
  assert.equal(results[0].destination, "posthog");
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error.message, /destination failed/);
  assert.deepEqual(results[1], {
    destination: "statsig",
    status: "exported",
  });
});

test("delivery-state persistence failure remains retryable", async () => {
  await assert.rejects(
    routeEventDestinations(
      { id: "evt_1", eventName: "account.created" },
      {},
      {
        destinations: [
          {
            name: "posthog",
            async exportEvent() {
              return { status: "exported" };
            },
          },
        ],
        async recordState() {
          throw new Error("delivery state unavailable");
        },
      },
    ),
    /delivery state unavailable/,
  );
});

test("rejects malformed destination definitions", async () => {
  await assert.rejects(
    routeEventDestinations(
      { id: "evt_1", eventName: "account.created" },
      {},
      {
        destinations: [{ name: "", exportEvent: async () => ({}) }],
        async recordState() {},
      },
    ),
    DestinationRouterConfigurationError,
  );
});


test("already exported destination is not sent again", async () => {
  let exportCalls = 0;
  let stateWrites = 0;

  const results = await routeEventDestinations(
    { id: "evt_done", eventName: "account.created" },
    {},
    {
      destinations: [
        {
          name: "statsig",
          async exportEvent() {
            exportCalls += 1;
            return { status: "exported" };
          },
        },
      ],
      async readState(_archive, eventId, destination) {
        assert.equal(eventId, "evt_done");
        assert.equal(destination, "statsig");
        return {
          eventId,
          destination,
          status: "exported",
        };
      },
      async recordState() {
        stateWrites += 1;
      },
    },
  );

  assert.equal(exportCalls, 0);
  assert.equal(stateWrites, 0);
  assert.deepEqual(results, [
    {
      destination: "statsig",
      status: "skipped",
      reason: "already_exported",
    },
  ]);
});


test("secondary project routes only to its configured destination set", async () => {
  const stateProjects = [];

  const results = await routeEventDestinations(
    {
      id: "evt_secondary",
      eventName: "account.created",
      provenance: {
        version: 2,
        projectId: "etlayer-secondary",
        profileId: "backend",
        authentication: "bearer_profile",
        producer: { kind: "backend" },
        allowedAuthorityKinds: ["business_state"],
      },
    },
    {},
    {
      async readState(
        _archive,
        _eventId,
        _destination,
        options,
      ) {
        stateProjects.push(options.projectId);
        return null;
      },
      async recordState() {},
    },
  );

  assert.deepEqual(
    results.map(({ destination }) => destination),
    ["posthog"],
  );
  assert.deepEqual(stateProjects, ["etlayer-secondary"]);
});

test("default project keeps PostHog and Statsig routing", async () => {
  const results = await routeEventDestinations(
    {
      id: "evt_default",
      eventName: "account.created",
      provenance: {
        version: 2,
        projectId: "etlayer-default",
        profileId: "backend",
        authentication: "bearer_profile",
        producer: { kind: "backend" },
        allowedAuthorityKinds: ["business_state"],
      },
    },
    {},
    {
      async readState() {
        return null;
      },
      async recordState() {},
    },
  );

  assert.deepEqual(
    results.map(({ destination }) => destination),
    ["posthog", "statsig"],
  );
});


function registryArchive() {
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
      objects.set(key, { body });
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
  };
}

async function createDynamicPostHogProject(
  archive,
  projectId,
  secret,
) {
  const operatorFingerprint =
    await credentialFingerprint(
      "operator-" + projectId,
    );

  await createRegistryProject(archive, {
    projectId,
    operatorFingerprint,
    now: new Date("2026-09-23T12:00:00.000Z"),
  });

  await setRegistryDestination(archive, {
    projectId,
    destination: "posthog",
    enabled: true,
    now: new Date("2026-09-23T12:00:01.000Z"),
  });

  if (secret) {
    await writeDestinationCredential(
      archive,
      {
        ETLAYER_DESTINATION_SECRET_KEY_V1:
          "22".repeat(32),
      },
      {
        projectId,
        destination: "posthog",
        secret,
        credentialId: "credential-" + projectId,
      },
    );
  }
}

function dynamicEvent(projectId, id) {
  return {
    id,
    eventName: "account.created",
    receivedAt: "2026-09-23T12:00:00.000Z",
    provenance: {
      version: 2,
      projectId,
      profileId: "backend",
      authentication: "bearer_profile",
      producer: { kind: "backend" },
      allowedAuthorityKinds: ["business_state"],
    },
    resource: { attributes: [] },
    scope: {},
    logRecord: { attributes: [] },
  };
}

test("dynamic projects route with their own encrypted PostHog credentials", async () => {
  const archive = registryArchive();
  await createDynamicPostHogProject(
    archive,
    "project-a",
    "phc_project_a",
  );
  await createDynamicPostHogProject(
    archive,
    "project-b",
    "phc_project_b",
  );

  const seen = [];
  const fetchImpl = async (_url, request) => {
    seen.push(JSON.parse(request.body).api_key);
    return new Response("", { status: 200 });
  };

  const env = {
    ARCHIVE: archive,
    ETLAYER_DESTINATION_SECRET_KEY_V1:
      "22".repeat(32),
    POSTHOG_HOST: "https://eu.i.posthog.com",
    POSTHOG_PROJECT_TOKEN: "global-must-not-be-used",
  };

  const routing = {
    posthog: { fetch: fetchImpl },
    async readState() {
      return null;
    },
    async recordState() {},
  };

  await routeEventDestinations(
    dynamicEvent("project-a", "evt-a"),
    env,
    routing,
  );
  await routeEventDestinations(
    dynamicEvent("project-b", "evt-b"),
    env,
    routing,
  );

  assert.deepEqual(seen, [
    "phc_project_a",
    "phc_project_b",
  ]);
});

test("dynamic project without credential never falls back to Worker-global PostHog token", async () => {
  const archive = registryArchive();
  await createDynamicPostHogProject(
    archive,
    "project-a",
    null,
  );

  let fetchCalls = 0;

  const results = await routeEventDestinations(
    dynamicEvent("project-a", "evt-no-secret"),
    {
      ARCHIVE: archive,
      POSTHOG_HOST: "https://eu.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "global-must-not-be-used",
    },
    {
      posthog: {
        async fetch() {
          fetchCalls += 1;
          return new Response("", { status: 200 });
        },
      },
      async readState() {
        return null;
      },
      async recordState() {},
    },
  );

  assert.equal(fetchCalls, 0);
  assert.equal(results[0].status, "skipped");
  assert.equal(
    results[0].reason,
    "posthog_not_configured",
  );
});

function deliveryArchive() {
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

      objects.set(key, body);
      return { key };
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
    async list({ prefix }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}

test("records append-only attempts and does not create one for already_exported short-circuit", async () => {
  const archive = deliveryArchive();
  const managedEvent = {
    id: "evt_attempt_history",
    eventName: "checkout.completed",
  };
  let phase = "not-configured";
  let exportCalls = 0;

  const destination = {
    name: "posthog",
    async exportEvent() {
      exportCalls += 1;

      if (phase === "not-configured") {
        return {
          status: "skipped",
          reason: "posthog_not_configured",
        };
      }

      return {
        status: "exported",
        uuid: "ph_evt_attempt_history",
      };
    },
  };

  const first = await routeEventDestinations(
    managedEvent,
    { ARCHIVE: archive },
    {
      destinations: [destination],
      now: new Date(
        "2026-09-25T17:10:00.000Z",
      ),
    },
  );

  phase = "configured";

  const second = await routeEventDestinations(
    managedEvent,
    { ARCHIVE: archive },
    {
      destinations: [destination],
      now: new Date(
        "2026-09-25T17:11:00.000Z",
      ),
      delivery: {
        mode: "revalidation",
      },
    },
  );

  const third = await routeEventDestinations(
    managedEvent,
    { ARCHIVE: archive },
    {
      destinations: [destination],
      now: new Date(
        "2026-09-25T17:12:00.000Z",
      ),
      delivery: {
        mode: "revalidation",
      },
    },
  );

  assert.equal(first[0].attemptNumber, 1);
  assert.equal(first[0].status, "skipped");
  assert.equal(second[0].attemptNumber, 2);
  assert.equal(second[0].status, "exported");
  assert.deepEqual(third, [
    {
      destination: "posthog",
      status: "skipped",
      reason: "already_exported",
    },
  ]);
  assert.equal(exportCalls, 2);

  const attempts = await listDeliveryAttempts(
    archive,
    managedEvent.id,
    "posthog",
  );

  assert.deepEqual(
    attempts.map(
      ({ attemptNumber, status, mode }) => [
        attemptNumber,
        status,
        mode,
      ],
    ),
    [
      [1, "skipped", "live"],
      [2, "exported", "revalidation"],
    ],
  );
});


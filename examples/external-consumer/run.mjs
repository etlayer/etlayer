import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const baseUrl = requiredEnv("ETLAYER_BASE_URL").replace(/\/$/, "");
const projectId = requiredEnv("ETLAYER_PROJECT_ID");
const operatorCredential = requiredEnv(
  "ETLAYER_OPERATOR_CREDENTIAL",
);

const onboardingUrl =
  baseUrl +
  "/api/v1/projects/" +
  encodeURIComponent(projectId) +
  "/onboarding";
const idempotencyKey =
  process.env.ETLAYER_IDEMPOTENCY_KEY ||
  "vs12-" + crypto.randomUUID();
const onboardingBody = {
  producerId: "backend-main",
  destinations: ["posthog"],
};

const first = await requestOnboardingWithPropagationRetry(
  onboardingUrl,
  {
    method: "POST",
    headers: {
      authorization: "Bearer " + operatorCredential,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(onboardingBody),
  },
);

assertStatus(first, 201, "first onboarding");
const firstBody = first.body;

assert(firstBody.apiVersion === "v1", "apiVersion must be v1");
assert(
  firstBody.projectId === projectId,
  "projectId must match consumer project",
);
assert(
  typeof firstBody.credential === "string" &&
    firstBody.credential.startsWith("etl_prod_"),
  "producer credential must be returned",
);
assert(
  firstBody.connection?.protocol === "otlp/http-json",
  "connection protocol must be OTLP/HTTP JSON",
);
assert(
  firstBody.connection?.endpoint === baseUrl + "/v1/logs",
  "connection endpoint must use standard OTLP path",
);
assert(
  firstBody.eventStatus?.method === "GET",
  "event status must use GET",
);
assert(
  firstBody.eventStatus?.urlTemplate ===
    baseUrl +
      "/api/v1/projects/" +
      encodeURIComponent(projectId) +
      "/events/{eventId}",
  "event status URL template must use public API",
);
assert(
  typeof firstBody.quickstart?.source === "string",
  "quickstart source is required",
);
assert(
  !firstBody.quickstart.source.includes(
    "etlayer.project.id",
  ),
  "quickstart must not claim project identity",
);

const replay = await requestJson(onboardingUrl, {
  method: "POST",
  headers: {
    authorization: "Bearer " + operatorCredential,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  },
  body: JSON.stringify(onboardingBody),
});

assertStatus(replay, 201, "idempotent onboarding replay");
assert(
  replay.headers.get("idempotency-replayed") === "true",
  "replay response must be marked",
);
assert(
  JSON.stringify(replay.body) === JSON.stringify(firstBody),
  "idempotent replay must return the same response",
);

const reused = await requestJson(onboardingUrl, {
  method: "POST",
  headers: {
    authorization: "Bearer " + operatorCredential,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  },
  body: JSON.stringify({
    producerId: "backend-main",
    destinations: ["statsig"],
  }),
});

assertStatus(reused, 409, "idempotency key reuse");
assert(
  reused.body?.error?.code === "idempotency_key_reused",
  "same key with different request must return stable conflict code",
);

const missingKey = await requestJson(onboardingUrl, {
  method: "POST",
  headers: {
    authorization: "Bearer " + operatorCredential,
    "content-type": "application/json",
  },
  body: JSON.stringify(onboardingBody),
});

assertStatus(missingKey, 400, "missing idempotency key");
assert(
  missingKey.body?.error?.code ===
    "idempotency_key_required",
  "missing key must return stable error code",
);

const invalidAuth = await requestJson(onboardingUrl, {
  method: "POST",
  headers: {
    authorization: "Bearer invalid-operator",
    "content-type": "application/json",
    "idempotency-key": "vs12-invalid-auth",
  },
  body: JSON.stringify(onboardingBody),
});

assertStatus(invalidAuth, 401, "invalid operator");
assert(
  invalidAuth.body?.error?.code ===
    "invalid_operator_credential",
  "invalid operator must return stable error code",
);

const malformed = await requestJson(onboardingUrl, {
  method: "POST",
  headers: {
    authorization: "Bearer " + operatorCredential,
    "content-type": "application/json",
    "idempotency-key": "vs12-malformed",
  },
  body: "{",
});

assertStatus(malformed, 400, "malformed JSON");
assert(
  malformed.body?.error?.code === "invalid_request",
  "malformed JSON must return stable error code",
);

const unsupportedMedia = await requestJson(onboardingUrl, {
  method: "POST",
  headers: {
    authorization: "Bearer " + operatorCredential,
    "content-type": "text/plain",
    "idempotency-key": "vs12-media",
  },
  body: "{}",
});

assertStatus(
  unsupportedMedia,
  415,
  "unsupported media type",
);
assert(
  unsupportedMedia.body?.error?.code ===
    "unsupported_media_type",
  "unsupported media type must return stable error code",
);

const temp = mkdtempSync(
  join(tmpdir(), "etlayer-vs12-consumer-"),
);

let emitted;
try {
  const quickstartPath = join(
    temp,
    firstBody.quickstart.filename ||
      "first-etlayer-event.mjs",
  );
  writeFileSync(
    quickstartPath,
    firstBody.quickstart.source,
    "utf8",
  );

  const execution = spawnSync(
    process.execPath,
    [quickstartPath],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
      },
    },
  );

  if (execution.status !== 0) {
    throw new Error(
      "generated quickstart failed: " +
        execution.stderr +
        execution.stdout,
    );
  }

  emitted = JSON.parse(execution.stdout);
} finally {
  rmSync(temp, {
    recursive: true,
    force: true,
  });
}

assert(
  typeof emitted?.eventId === "string" &&
    emitted.eventId.length > 0,
  "quickstart must print eventId",
);
assert(
  emitted.projectId === projectId,
  "quickstart output project must match",
);
assert(
  emitted.eventStatus?.method === "GET",
  "quickstart must return public event status coordinates",
);

const expectedStatusUrl =
  baseUrl +
  "/api/v1/projects/" +
  encodeURIComponent(projectId) +
  "/events/" +
  encodeURIComponent(emitted.eventId);

assert(
  emitted.eventStatus?.url === expectedStatusUrl,
  "quickstart event status URL must be public",
);

const finalStatus = await waitForComplete(
  expectedStatusUrl,
  operatorCredential,
);

assert(
  finalStatus.validation?.status === "valid",
  "event contract must be valid",
);
assert(
  finalStatus.authority?.status === "allowed",
  "event authority must be allowed",
);
assert(
  finalStatus.decision?.routeEligible === true,
  "event must be route eligible",
);

const posthog = finalStatus.deliveries?.find(
  ({ destination }) => destination === "posthog",
);
assert(
  posthog?.status === "exported",
  "PostHog delivery must be exported",
);
assert(
  !JSON.stringify(finalStatus).includes("sourceKey"),
  "public event status must not expose sourceKey",
);

const idempotencyKeyFingerprint =
  await sha256Hex(idempotencyKey);
const producerCredentialFingerprint =
  await sha256Hex(firstBody.credential);

process.stdout.write(
  JSON.stringify(
    {
      projectId,
      eventId: emitted.eventId,
      idempotencyKeyFingerprint,
      producerCredentialFingerprint,
      idempotencyReplay: true,
      sameCredentialReplayed:
        replay.body.credential === firstBody.credential,
      conflictCode: reused.body.error.code,
      validation: finalStatus.validation.status,
      authority: finalStatus.authority.status,
      routeEligible: finalStatus.decision.routeEligible,
      posthogDelivery: posthog.status,
      eventStatusUrl: expectedStatusUrl,
    },
    null,
    2,
  ) + "\n",
);

async function requestOnboardingWithPropagationRetry(
  url,
  init,
) {
  let last = null;

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    last = await requestJson(url, init);

    if (last.status !== 503) {
      return last;
    }

    if (
      last.body?.error?.code !== "service_unavailable"
    ) {
      return last;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 1000),
    );
  }

  return last;
}

async function waitForComplete(url, credential) {
  let last = null;

  for (let attempt = 1; attempt <= 45; attempt += 1) {
    const response = await requestJson(url, {
      method: "GET",
      headers: {
        authorization: "Bearer " + credential,
      },
    });

    assertStatus(response, 200, "event status");
    last = response.body;

    if (last.status === "complete") {
      return last;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 1000),
    );
  }

  throw new Error(
    "event status never reached complete: " +
      JSON.stringify(last),
  );
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();

  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        "non-JSON response from public contract: " +
          response.status +
          " " +
          text,
      );
    }
  }

  return {
    status: response.status,
    headers: response.headers,
    body,
  };
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(
      label +
        " expected HTTP " +
        expected +
        " but got " +
        response.status +
        ": " +
        JSON.stringify(response.body),
    );
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing required environment variable: " + name);
  }
  return value;
}

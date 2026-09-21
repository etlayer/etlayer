const BROWSER_EVENTS = new Set([
  "landing.hero.exposed",
  "landing.hero.cta_clicked",
]);

const ACTOR_COOKIE = "etel_actor_id";
const FUNNEL_COOKIE = "etel_funnel_id";
const SESSION_COOKIE = "etel_session_id";
const ATTR_SOURCE_COOKIE = "etel_attr_source";
const ATTR_MEDIUM_COOKIE = "etel_attr_medium";
const ATTR_CAMPAIGN_COOKIE = "etel_attr_campaign";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        etlayerOtlpEndpoint: env.ETLAYER_OTLP_ENDPOINT || null,
        etlayerServiceBinding:
          Boolean(env.ETLAYER && typeof env.ETLAYER.fetch === "function"),
      });
    }

    if (request.method === "GET" && url.pathname === "/fixture.js") {
      return javascriptResponse(browserScript());
    }

    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.pathname === "/") {
      const context = contextForLanding(request, url);
      return htmlResponse(indexHtml(context), context.setCookies);
    }

    if (request.method === "POST" && url.pathname === "/api/browser-event") {
      return handleBrowserEvent(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/account") {
      return handleAccountCreated(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/acceptance/invalid-account"
    ) {
      return handleInvalidAccountAcceptance(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/acceptance/privacy-account"
    ) {
      return handlePrivacyAccountAcceptance(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/acceptance/identity-flow"
    ) {
      return handleIdentityFlowAcceptance(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function readFunnelResult(env, correlationId, eventName) {
  if (!env.STATE || typeof env.STATE.get !== "function") return null;

  const key = funnelResultKey(correlationId, eventName);
  const object = await env.STATE.get(key);
  if (!object) return null;

  try {
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

async function writeFunnelResult(env, correlationId, eventName, result) {
  if (!env.STATE || typeof env.STATE.put !== "function") return;

  await env.STATE.put(
    funnelResultKey(correlationId, eventName),
    JSON.stringify(result),
    {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
      customMetadata: {
        correlation_id: correlationId,
        event_name: eventName,
      },
    },
  );
}

function funnelResultKey(correlationId, eventName) {
  return `funnels/${encodeURIComponent(correlationId)}/${encodeURIComponent(eventName)}.json`;
}

export async function handleBrowserEvent(request, env, options = {}) {
  const payload = await readJson(request);

  if (!payload || !BROWSER_EVENTS.has(payload.eventName)) {
    return jsonResponse({ ok: false, error: "unsupported_event" }, 400);
  }

  const context = contextFromRequest(request);
  if (!context) {
    return jsonResponse({ ok: false, error: "missing_funnel_context" }, 409);
  }

  const previous = await readFunnelResult(
    env,
    context.correlationId,
    payload.eventName,
  );

  if (previous) {
    return jsonResponse({
      ...previous,
      duplicate: true,
      correlationId: context.correlationId,
    }, 200);
  }

  const attributes = {
    ...sanitizeAttributes(payload.attributes),
    "actor.anonymous.id": context.actorId,
    "session.id": context.sessionId,
    "correlation.id": context.correlationId,
    ...attributionAttributes(context.attribution),
    "etlayer.producer.kind": "browser",
    "etlayer.authority.kind": "interaction",
    "experiment.id": "hero.v1",
    "experiment.variant": "fixture-a",
  };

  const causationId = safeIdentifier(payload.causationId);
  if (causationId) attributes["causation.id"] = causationId;

  const result = await emitOtlpEvent(
    env,
    payload.eventName,
    attributes,
    options,
  );

  const responseBody = {
    ...result.body,
    correlationId: context.correlationId,
  };

  if (result.status >= 200 && result.status < 300 && result.body?.ok) {
    await writeFunnelResult(
      env,
      context.correlationId,
      payload.eventName,
      responseBody,
    );
  }

  return jsonResponse(responseBody, result.status);
}

export async function handleAccountCreated(request, env, options = {}) {
  const context = contextFromRequest(request);
  if (!context) {
    return jsonResponse({ ok: false, error: "missing_funnel_context" }, 409);
  }

  if (
    !env.STATE ||
    typeof env.STATE.put !== "function" ||
    typeof env.STATE.get !== "function"
  ) {
    return jsonResponse({ ok: false, error: "missing_backend_state" }, 503);
  }

  const previous = await readFunnelResult(
    env,
    context.correlationId,
    "account.created",
  );

  if (previous) {
    return jsonResponse({
      ...previous,
      duplicate: true,
      correlationId: context.correlationId,
    }, 200);
  }

  const payload = (await readJson(request)) || {};
  const accountId = `fixture_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const stateKey = `accounts/${accountId}.json`;

  await env.STATE.put(
    stateKey,
    JSON.stringify({
      id: accountId,
      createdAt,
      actorAnonymousId: context.actorId,
      correlationId: context.correlationId,
    }),
    {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
      customMetadata: {
        account_id: accountId,
        correlation_id: context.correlationId,
      },
    },
  );

  const attributes = {
    "actor.anonymous.id": context.actorId,
    "account.id": accountId,
    "session.id": context.sessionId,
    "correlation.id": context.correlationId,
    ...attributionAttributes(context.attribution),
    "etlayer.producer.kind": "backend",
    "etlayer.authority.kind": "business_state",
  };

  const causationId = safeIdentifier(payload.causationId);
  if (causationId) attributes["causation.id"] = causationId;

  const result = await emitOtlpEvent(
    env,
    "account.created",
    attributes,
    options,
  );

  const responseBody = {
    ...result.body,
    accountId,
    stateKey,
    createdAt,
    correlationId: context.correlationId,
  };

  if (result.status >= 200 && result.status < 300 && result.body?.ok) {
    await writeFunnelResult(
      env,
      context.correlationId,
      "account.created",
      responseBody,
    );
  }

  return jsonResponse(responseBody, result.status);
}

export async function handleInvalidAccountAcceptance(
  request,
  env,
  options = {},
) {
  const context = contextFromRequest(request);
  if (!context) {
    return jsonResponse(
      { ok: false, error: "missing_funnel_context" },
      409,
    );
  }

  const payload = (await readJson(request)) || {};
  const causationId =
    safeIdentifier(payload.causationId) ||
    "vs3_acceptance_root";

  const result = await emitOtlpEvent(
    env,
    "account.created",
    {
      "actor.anonymous.id": context.actorId,
      "correlation.id": context.correlationId,
      "causation.id": causationId,
      "etlayer.producer.kind": "backend",
      "etlayer.authority.kind": "business_state",
    },
    options,
  );

  return jsonResponse(
    {
      ...result.body,
      correlationId: context.correlationId,
      intentionallyInvalid: true,
      missingAttribute: "account.id",
    },
    result.status,
  );
}

export async function handlePrivacyAccountAcceptance(
  request,
  env,
  options = {},
) {
  const context = contextFromRequest(request);
  if (!context) {
    return jsonResponse(
      { ok: false, error: "missing_funnel_context" },
      409,
    );
  }

  if (
    !env.STATE ||
    typeof env.STATE.put !== "function"
  ) {
    return jsonResponse(
      { ok: false, error: "missing_backend_state" },
      503,
    );
  }

  const payload = (await readJson(request)) || {};
  const accountId =
    options.accountId ||
    `fixture_privacy_${crypto.randomUUID()}`;
  const createdAt = new Date(
    options.nowMs ?? Date.now(),
  ).toISOString();
  const stateKey = `accounts/${accountId}.json`;

  await env.STATE.put(
    stateKey,
    JSON.stringify({
      id: accountId,
      createdAt,
      actorAnonymousId: context.actorId,
      correlationId: context.correlationId,
      acceptanceKind: "privacy",
    }),
    {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
      customMetadata: {
        account_id: accountId,
        correlation_id: context.correlationId,
      },
    },
  );

  const causationId =
    safeIdentifier(payload.causationId) ||
    "vs4_privacy_acceptance_root";

  const result = await emitOtlpEvent(
    env,
    "account.created",
    {
      "actor.anonymous.id": context.actorId,
      "account.id": accountId,
      "correlation.id": context.correlationId,
      "causation.id": causationId,
      "etlayer.producer.kind": "backend",
      "etlayer.authority.kind": "business_state",
      "user.email": "acceptance@example.test",
      "auth.token": "acceptance-secret-do-not-store",
    },
    options,
  );

  return jsonResponse(
    {
      ...result.body,
      correlationId: context.correlationId,
      accountId,
      stateKey,
      privacyAcceptance: true,
      expectedCanonicalField: "user.email",
      expectedIngestDrop: "auth.token",
      expectedDeliveryDrop: "user.email",
    },
    result.status,
  );
}

export async function handleIdentityFlowAcceptance(
  request,
  env,
  options = {},
) {
  const context = contextFromRequest(request);
  if (!context) {
    return jsonResponse(
      { ok: false, error: "missing_funnel_context" },
      409,
    );
  }

  if (!env.STATE || typeof env.STATE.put !== "function") {
    return jsonResponse(
      { ok: false, error: "missing_backend_state" },
      503,
    );
  }

  const payload = (await readJson(request)) || {};
  const causationId =
    safeIdentifier(payload.causationId) ||
    "vs5_identity_acceptance_root";

  const userId =
    options.userId ||
    `user_${crypto.randomUUID()}`;
  const accountId =
    options.accountId ||
    `account_${crypto.randomUUID()}`;
  const createdAt = new Date(
    options.nowMs ?? Date.now(),
  ).toISOString();

  await env.STATE.put(
    `users/${userId}.json`,
    JSON.stringify({
      id: userId,
      createdAt,
      actorAnonymousId: context.actorId,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
      acceptanceKind: "identity",
    }),
  );

  await env.STATE.put(
    `accounts/${accountId}.json`,
    JSON.stringify({
      id: accountId,
      createdAt,
      userId,
      actorAnonymousId: context.actorId,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
      acceptanceKind: "identity",
    }),
  );

  const common = {
    "actor.anonymous.id": context.actorId,
    "user.id": userId,
    "account.id": accountId,
    "session.id": context.sessionId,
    "correlation.id": context.correlationId,
    ...attributionAttributes(context.attribution),
    "etlayer.producer.kind": "backend",
    "etlayer.authority.kind": "business_state",
  };

  const {
    linkEventId,
    accountEventId,
    userId: _userId,
    accountId: _accountId,
    ...emitOptions
  } = options;

  const linkResult = await emitOtlpEvent(
    env,
    "identity.linked",
    {
      ...common,
      "causation.id": causationId,
    },
    {
      ...emitOptions,
      eventId: linkEventId,
    },
  );

  if (
    linkResult.status < 200 ||
    linkResult.status >= 300 ||
    !linkResult.body?.ok
  ) {
    return jsonResponse(
      {
        ...linkResult.body,
        correlationId: context.correlationId,
        stage: "identity.linked",
      },
      linkResult.status,
    );
  }

  const accountResult = await emitOtlpEvent(
    env,
    "account.created",
    {
      ...common,
      "causation.id": linkResult.body.eventId,
    },
    {
      ...emitOptions,
      eventId: accountEventId,
    },
  );

  return jsonResponse(
    {
      ok: accountResult.body?.ok === true,
      correlationId: context.correlationId,
      anonymousId: context.actorId,
      sessionId: context.sessionId,
      userId,
      accountId,
      identityEventId: linkResult.body.eventId,
      accountEventId: accountResult.body?.eventId || null,
      attribution: context.attribution,
    },
    accountResult.status,
  );
}

export async function emitOtlpEvent(env, eventName, attributes, options = {}) {
  if (!env.ETLAYER_OTLP_ENDPOINT) {
    return {
      status: 500,
      body: { ok: false, error: "missing_etlayer_endpoint" },
    };
  }

  const eventId = options.eventId || crypto.randomUUID();
  const nowUnixNano = (
    BigInt(options.nowMs ?? Date.now()) * 1_000_000n
  ).toString();

  const body = {
    resourceLogs: [
      {
        resource: {
          attributes: toOtlpAttributes({
            "service.name": "etlayer-cloudflare-fixture",
            "deployment.environment.name":
              env.DEPLOYMENT_ENVIRONMENT_NAME || "acceptance",
          }),
        },
        scopeLogs: [
          {
            scope: {
              name: "etlayer.cloudflare-fixture",
              version: "0.2.0",
            },
            logRecords: [
              {
                eventName,
                timeUnixNano: nowUnixNano,
                observedTimeUnixNano: nowUnixNano,
                attributes: toOtlpAttributes({
                  "etlayer.event.id": eventId,
                  "etlayer.schema.version": 1,
                  ...attributes,
                }),
              },
            ],
          },
        ],
      },
    ],
  };

  const headers = {
    "content-type": "application/json",
  };

  if (env.ETLAYER_INGEST_KEY) {
    headers.authorization = `Bearer ${env.ETLAYER_INGEST_KEY}`;
  }

  const request = new Request(env.ETLAYER_OTLP_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  let response;

  if (options.fetch) {
    response = await options.fetch(request);
  } else if (env.ETLAYER && typeof env.ETLAYER.fetch === "function") {
    response = await env.ETLAYER.fetch(request);
  } else {
    response = await fetch(request);
  }

  if (!response.ok) {
    return {
      status: 502,
      body: {
        ok: false,
        error: "etlayer_rejected_event",
        eventId,
        eventName,
        upstreamStatus: response.status,
        upstreamUrl: env.ETLAYER_OTLP_ENDPOINT,
      },
    };
  }

  return {
    status: 202,
    body: {
      ok: true,
      eventId,
      eventName,
    },
  };
}

function contextForLanding(request, url) {
  const cookies = parseCookies(request.headers.get("cookie"));
  let actorId = safeIdentifier(cookies[ACTOR_COOKIE]);
  let sessionId = safeIdentifier(cookies[SESSION_COOKIE]);
  const setCookies = [];

  if (!actorId) {
    actorId = `anon_${crypto.randomUUID()}`;
    setCookies.push(
      cookieHeader(ACTOR_COOKIE, actorId, {
        maxAge: COOKIE_MAX_AGE_SECONDS,
      }),
    );
  }

  if (!sessionId) {
    sessionId = `session_${crypto.randomUUID()}`;
    setCookies.push(cookieHeader(SESSION_COOKIE, sessionId));
  }

  const requestedRun = safeIdentifier(url.searchParams.get("run"));
  const correlationId =
    requestedRun || `funnel_${crypto.randomUUID()}`;

  setCookies.push(cookieHeader(FUNNEL_COOKIE, correlationId));

  const attribution = {
    source:
      safeIdentifier(url.searchParams.get("utm_source")) ||
      safeIdentifier(cookies[ATTR_SOURCE_COOKIE]),
    medium:
      safeIdentifier(url.searchParams.get("utm_medium")) ||
      safeIdentifier(cookies[ATTR_MEDIUM_COOKIE]),
    campaign:
      safeIdentifier(url.searchParams.get("utm_campaign")) ||
      safeIdentifier(cookies[ATTR_CAMPAIGN_COOKIE]),
  };

  for (const [cookie, value] of [
    [ATTR_SOURCE_COOKIE, attribution.source],
    [ATTR_MEDIUM_COOKIE, attribution.medium],
    [ATTR_CAMPAIGN_COOKIE, attribution.campaign],
  ]) {
    if (value) {
      setCookies.push(
        cookieHeader(cookie, value, {
          maxAge: COOKIE_MAX_AGE_SECONDS,
        }),
      );
    }
  }

  return {
    actorId,
    sessionId,
    correlationId,
    attribution,
    setCookies,
  };
}

function contextFromRequest(request) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const actorId = safeIdentifier(cookies[ACTOR_COOKIE]);
  const sessionId = safeIdentifier(cookies[SESSION_COOKIE]);
  const correlationId = safeIdentifier(cookies[FUNNEL_COOKIE]);

  if (!actorId || !sessionId || !correlationId) return null;

  return {
    actorId,
    sessionId,
    correlationId,
    attribution: {
      source: safeIdentifier(cookies[ATTR_SOURCE_COOKIE]),
      medium: safeIdentifier(cookies[ATTR_MEDIUM_COOKIE]),
      campaign: safeIdentifier(cookies[ATTR_CAMPAIGN_COOKIE]),
    },
  };
}

function attributionAttributes(attribution) {
  if (!attribution) return {};

  return Object.fromEntries(
    [
      ["attribution.source", attribution.source],
      ["attribution.medium", attribution.medium],
      ["attribution.campaign", attribution.campaign],
    ].filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}

function safeIdentifier(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();

  if (
    trimmed.length === 0 ||
    trimmed.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

function cookieHeader(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];

  if (options.maxAge) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  return parts.join("; ");
}

function parseCookies(header) {
  if (!header) return {};

  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [
          part.slice(0, index),
          decodeURIComponent(part.slice(index + 1)),
        ];
      }),
  );
}

function sanitizeAttributes(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) =>
        typeof key === "string" &&
        ["string", "number", "boolean"].includes(typeof value),
    ),
  );
}

function toOtlpAttributes(attributes) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: toOtlpValue(value),
  }));
}

function toOtlpValue(value) {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }

  return { stringValue: String(value) };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function htmlResponse(body, setCookies = []) {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });

  for (const cookie of setCookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(body, { headers });
}

function indexHtml(context) {
  const correlationId = escapeHtml(context.correlationId);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ETLayer Acceptance Funnel</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 64px auto; padding: 0 20px; }
    .meta { opacity: .72; font-size: 14px; }
    button { margin: 8px 8px 8px 0; padding: 10px 14px; }
    pre { margin-top: 24px; padding: 16px; background: rgba(127,127,127,.12); overflow: auto; white-space: pre-wrap; }
  </style>
</head>
<body data-correlation-id="${correlationId}">
  <h1>ETLayer Acceptance Funnel</h1>
  <p>Browser interaction → browser CTA → backend account state transition. One OTLP path.</p>
  <p class="meta">correlation.id: <code id="run-id"></code></p>

  <button id="cta" disabled>Try ETLayer</button>
  <button id="account" disabled>Create test account</button>

  <pre id="output">Starting funnel…</pre>
  <script src="/fixture.js" defer></script>
</body>
</html>`;
}

function browserScript() {
  return String.raw`
const correlationId = document.body.dataset.correlationId;
const output = document.getElementById("output");
const cta = document.getElementById("cta");
const account = document.getElementById("account");
document.getElementById("run-id").textContent = correlationId;

const state = {
  correlationId,
  exposedEventId: null,
  ctaEventId: null,
  accountEventId: null,
  accountId: null,
};

function render(message) {
  output.textContent = message + "\\n\\n" + JSON.stringify(state, null, 2);
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(result));
  }
  return result;
}

async function exposeHero() {
  const result = await post("/api/browser-event", {
    eventName: "landing.hero.exposed",
    attributes: {
      "page.path": location.pathname,
    },
  });

  state.exposedEventId = result.eventId;
  cta.disabled = false;
  render("✓ landing.hero.exposed");
}

cta.addEventListener("click", async () => {
  cta.disabled = true;

  try {
    const result = await post("/api/browser-event", {
      eventName: "landing.hero.cta_clicked",
      causationId: state.exposedEventId,
      attributes: {
        "page.path": location.pathname,
        "cta.name": "try_etlayer",
      },
    });

    state.ctaEventId = result.eventId;
    account.disabled = false;
    render("✓ landing.hero.cta_clicked");
  } catch (error) {
    cta.disabled = false;
    render("✗ CTA failed: " + error.message);
  }
});

account.addEventListener("click", async () => {
  account.disabled = true;

  try {
    const result = await post("/api/account", {
      causationId: state.ctaEventId,
    });

    state.accountEventId = result.eventId;
    state.accountId = result.accountId;
    render("✓ account.created — funnel complete");
  } catch (error) {
    account.disabled = false;
    render("✗ account creation failed: " + error.message);
  }
});

exposeHero().catch((error) => {
  render("✗ hero exposure failed: " + error.message);
});
`;
}

function javascriptResponse(body) {
  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

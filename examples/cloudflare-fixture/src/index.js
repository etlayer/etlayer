const BROWSER_EVENTS = new Set([
  "landing.hero.exposed",
  "landing.hero.cta_clicked",
]);

const ACTOR_COOKIE = "etel_actor_id";
const FUNNEL_COOKIE = "etel_funnel_id";
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

    return new Response("Not found", { status: 404 });
  },
};

export async function handleBrowserEvent(request, env, options = {}) {
  const payload = await readJson(request);

  if (!payload || !BROWSER_EVENTS.has(payload.eventName)) {
    return jsonResponse({ ok: false, error: "unsupported_event" }, 400);
  }

  const context = contextFromRequest(request);
  if (!context) {
    return jsonResponse({ ok: false, error: "missing_funnel_context" }, 409);
  }

  const attributes = {
    ...sanitizeAttributes(payload.attributes),
    "actor.anonymous.id": context.actorId,
    "correlation.id": context.correlationId,
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

  return jsonResponse(
    {
      ...result.body,
      correlationId: context.correlationId,
    },
    result.status,
  );
}

export async function handleAccountCreated(request, env, options = {}) {
  const context = contextFromRequest(request);
  if (!context) {
    return jsonResponse({ ok: false, error: "missing_funnel_context" }, 409);
  }

  if (!env.STATE || typeof env.STATE.put !== "function") {
    return jsonResponse({ ok: false, error: "missing_backend_state" }, 503);
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
    "correlation.id": context.correlationId,
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

  return jsonResponse(
    {
      ...result.body,
      accountId,
      stateKey,
      createdAt,
      correlationId: context.correlationId,
    },
    result.status,
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
  const setCookies = [];

  if (!actorId) {
    actorId = `anon_${crypto.randomUUID()}`;
    setCookies.push(
      cookieHeader(ACTOR_COOKIE, actorId, {
        maxAge: COOKIE_MAX_AGE_SECONDS,
      }),
    );
  }

  const requestedRun = safeIdentifier(url.searchParams.get("run"));
  const correlationId =
    requestedRun || `funnel_${crypto.randomUUID()}`;

  setCookies.push(cookieHeader(FUNNEL_COOKIE, correlationId));

  return {
    actorId,
    correlationId,
    setCookies,
  };
}

function contextFromRequest(request) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const actorId = safeIdentifier(cookies[ACTOR_COOKIE]);
  const correlationId = safeIdentifier(cookies[FUNNEL_COOKIE]);

  if (!actorId || !correlationId) return null;

  return { actorId, correlationId };
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
  <title>ETLayer VS1 Funnel Fixture</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 64px auto; padding: 0 20px; }
    .meta { opacity: .72; font-size: 14px; }
    button { margin: 8px 8px 8px 0; padding: 10px 14px; }
    pre { margin-top: 24px; padding: 16px; background: rgba(127,127,127,.12); overflow: auto; white-space: pre-wrap; }
  </style>
</head>
<body data-correlation-id="${correlationId}">
  <h1>ETLayer VS1 Funnel</h1>
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

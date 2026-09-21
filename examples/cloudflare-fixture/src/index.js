const browserEvents = new Set([
  "landing.hero.exposed",
  "landing.hero.cta_clicked",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return htmlResponse(indexHtml());
    }

    if (request.method === "POST" && url.pathname === "/api/browser-event") {
      return handleBrowserEvent(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/account") {
      return handleAccountCreated(env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleBrowserEvent(request, env) {
  const payload = await readJson(request);

  if (!payload || !browserEvents.has(payload.eventName)) {
    return jsonResponse({ ok: false, error: "unsupported_event" }, 400);
  }

  const attributes = {
    "event.source.type": "browser",
    "experiment.id": "hero.v1",
    "experiment.variant": "fixture-a",
    ...sanitizeAttributes(payload.attributes),
  };

  const result = await emitOtlpEvent(env, payload.eventName, attributes);
  return jsonResponse(result.body, result.status);
}

async function handleAccountCreated(env) {
  const accountId = `fixture_${crypto.randomUUID()}`;

  const result = await emitOtlpEvent(env, "account.created", {
    "event.source.type": "backend",
    "account.id": accountId,
  });

  return jsonResponse(
    {
      ...result.body,
      accountId,
    },
    result.status,
  );
}

async function emitOtlpEvent(env, eventName, attributes) {
  if (!env.ETLAYER_OTLP_ENDPOINT) {
    return {
      status: 500,
      body: { ok: false, error: "missing_etlayer_endpoint" },
    };
  }

  const eventId = crypto.randomUUID();
  const nowUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();

  const body = {
    resourceLogs: [
      {
        resource: {
          attributes: toOtlpAttributes({
            "service.name": "etlayer-cloudflare-fixture",
            "deployment.environment.name": "development",
          }),
        },
        scopeLogs: [
          {
            scope: {
              name: "etlayer.cloudflare-fixture",
              version: "0.1.0",
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

  const response = await fetch(env.ETLAYER_OTLP_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return {
      status: 502,
      body: {
        ok: false,
        error: "etlayer_rejected_event",
        eventId,
        upstreamStatus: response.status,
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

function sanitizeAttributes(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input).filter(([, value]) =>
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

function htmlResponse(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function indexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ETLayer Cloudflare Fixture</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 64px auto; padding: 0 20px; }
    button { margin-right: 8px; padding: 10px 14px; }
    pre { margin-top: 24px; padding: 16px; background: #f4f4f4; overflow: auto; }
  </style>
</head>
<body>
  <h1>ETLayer Cloudflare Fixture</h1>
  <p>One browser producer. One backend producer. One OTLP ingest path.</p>

  <button id="cta">Try ETLayer</button>
  <button id="account">Create test account</button>

  <pre id="output">Ready.</pre>

  <script>
    const output = document.getElementById("output");

    async function post(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });

      const result = await response.json();
      output.textContent = JSON.stringify(result, null, 2);
      return result;
    }

    post("/api/browser-event", {
      eventName: "landing.hero.exposed",
      attributes: {
        "page.path": location.pathname,
      },
    });

    document.getElementById("cta").addEventListener("click", () =>
      post("/api/browser-event", {
        eventName: "landing.hero.cta_clicked",
        attributes: {
          "page.path": location.pathname,
          "cta.name": "try_etlayer",
        },
      }),
    );

    document.getElementById("account").addEventListener("click", () =>
      post("/api/account"),
    );
  </script>
</body>
</html>`;
}

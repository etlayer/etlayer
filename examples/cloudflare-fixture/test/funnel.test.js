import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  handleAccountCreated,
  handleBrowserEvent,
} from "../src/index.js";

function cookieHeader() {
  return "etel_actor_id=anon_test; etel_funnel_id=funnel_test";
}

function decodeAttributes(list) {
  return Object.fromEntries(
    list.map(({ key, value }) => {
      if ("stringValue" in value) return [key, value.stringValue];
      if ("intValue" in value) return [key, Number(value.intValue)];
      if ("boolValue" in value) return [key, value.boolValue];
      if ("doubleValue" in value) return [key, value.doubleValue];
      return [key, null];
    }),
  );
}

function captureFetch(captures) {
  return async (input, init) => {
    const body =
      input instanceof Request
        ? await input.clone().text()
        : init?.body;

    captures.push(JSON.parse(body));
    return new Response("{}", { status: 200 });
  };
}

function recordFrom(capture) {
  return capture.resourceLogs[0].scopeLogs[0].logRecords[0];
}

test("browser exposure preserves stable actor, correlation, source, and experiment context", async () => {
  const captures = [];

  const request = new Request("https://fixture.test/api/browser-event", {
    method: "POST",
    headers: {
      cookie: cookieHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      eventName: "landing.hero.exposed",
      attributes: { "page.path": "/" },
    }),
  });

  const response = await handleBrowserEvent(
    request,
    {
      ETLAYER_OTLP_ENDPOINT: "https://events.test/v1/logs",
      ETLAYER_INGEST_KEY: "test-key",
    },
    {
      fetch: captureFetch(captures),
      eventId: "11111111-1111-4111-8111-111111111111",
      nowMs: 1_790_000_000_000,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(captures.length, 1);

  const record = recordFrom(captures[0]);
  const attributes = decodeAttributes(record.attributes);

  assert.equal(record.eventName, "landing.hero.exposed");
  assert.equal(attributes["actor.anonymous.id"], "anon_test");
  assert.equal(attributes["correlation.id"], "funnel_test");
  assert.equal(attributes["etlayer.producer.kind"], "browser");
  assert.equal(attributes["etlayer.authority.kind"], "interaction");
  assert.equal(attributes["experiment.id"], "hero.v1");
  assert.equal(attributes["experiment.variant"], "fixture-a");
});

test("deployed-style browser event uses the ETLayer service binding", async () => {
  const calls = [];

  const request = new Request("https://fixture.test/api/browser-event", {
    method: "POST",
    headers: {
      cookie: cookieHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      eventName: "landing.hero.exposed",
    }),
  });

  const response = await handleBrowserEvent(request, {
    ETLAYER_OTLP_ENDPOINT: "https://etlayer-ingest.example/v1/logs",
    ETLAYER_INGEST_KEY: "test-key",
    ETLAYER: {
      async fetch(upstreamRequest) {
        calls.push({
          url: upstreamRequest.url,
          method: upstreamRequest.method,
          authorization: upstreamRequest.headers.get("authorization"),
          body: JSON.parse(await upstreamRequest.clone().text()),
        });

        return new Response("{}", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://etlayer-ingest.example/v1/logs");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].authorization, "Bearer test-key");
  assert.equal(
    calls[0].body.resourceLogs[0].scopeLogs[0].logRecords[0].eventName,
    "landing.hero.exposed",
  );
});

test("browser CTA records causation from the exposure event", async () => {
  const captures = [];

  const request = new Request("https://fixture.test/api/browser-event", {
    method: "POST",
    headers: {
      cookie: cookieHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      eventName: "landing.hero.cta_clicked",
      causationId: "11111111-1111-4111-8111-111111111111",
    }),
  });

  await handleBrowserEvent(
    request,
    {
      ETLAYER_OTLP_ENDPOINT: "https://events.test/v1/logs",
      ETLAYER_INGEST_KEY: "test-key",
    },
    {
      fetch: captureFetch(captures),
      eventId: "22222222-2222-4222-8222-222222222222",
    },
  );

  const attributes = decodeAttributes(recordFrom(captures[0]).attributes);
  assert.equal(
    attributes["causation.id"],
    "11111111-1111-4111-8111-111111111111",
  );
});

test("account.created follows a real backend state write and preserves the same funnel identity", async () => {
  const captures = [];
  const stateWrites = [];

  const request = new Request("https://fixture.test/api/account", {
    method: "POST",
    headers: {
      cookie: cookieHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      causationId: "22222222-2222-4222-8222-222222222222",
    }),
  });

  const response = await handleAccountCreated(
    request,
    {
      ETLAYER_OTLP_ENDPOINT: "https://events.test/v1/logs",
      ETLAYER_INGEST_KEY: "test-key",
      STATE: {
        async put(key, body, options) {
          stateWrites.push({ key, body, options });
        },
      },
    },
    {
      fetch: captureFetch(captures),
      eventId: "33333333-3333-4333-8333-333333333333",
    },
  );

  assert.equal(response.status, 202);
  assert.equal(stateWrites.length, 1);
  assert.match(stateWrites[0].key, /^accounts\/fixture_/);

  const storedAccount = JSON.parse(stateWrites[0].body);
  assert.equal(storedAccount.actorAnonymousId, "anon_test");
  assert.equal(storedAccount.correlationId, "funnel_test");

  const record = recordFrom(captures[0]);
  const attributes = decodeAttributes(record.attributes);

  assert.equal(record.eventName, "account.created");
  assert.equal(attributes["actor.anonymous.id"], "anon_test");
  assert.equal(attributes["correlation.id"], "funnel_test");
  assert.equal(attributes["etlayer.producer.kind"], "backend");
  assert.equal(attributes["etlayer.authority.kind"], "business_state");
  assert.equal(
    attributes["causation.id"],
    "22222222-2222-4222-8222-222222222222",
  );
  assert.match(attributes["account.id"], /^fixture_/);
  assert.equal(attributes["experiment.id"], undefined);
});


test("landing page references the external fixture script", async () => {
  const response = await worker.fetch(
    new Request("https://fixture.test/?run=funnel_test"),
    {},
  );

  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<script src="\/fixture\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script>.*<\/script>/s);
});

test("served fixture.js is valid JavaScript", async () => {
  const response = await worker.fetch(
    new Request("https://fixture.test/fixture.js"),
    {},
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type"),
    /^application\/javascript/,
  );

  const script = await response.text();
  assert.doesNotThrow(() => new Function(script));
});

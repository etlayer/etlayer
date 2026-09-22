import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  handleAccountCreated,
  handleBrowserEvent,
  handleInvalidAccountAcceptance,
  handlePrivacyAccountAcceptance,
  handleIdentityFlowAcceptance,
  handleAgentDelegationAcceptance,
  handleAuthoritySpoofAcceptance,
} from "../src/index.js";

function cookieHeader() {
  return [
    "etel_actor_id=anon_test",
    "etel_funnel_id=funnel_test",
    "etel_session_id=session_test",
    "etel_attr_source=docs",
    "etel_attr_medium=acceptance",
    "etel_attr_campaign=vs5",
  ].join("; ");
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


function fakeState() {
  const objects = new Map();

  return {
    objects,
    async get(key) {
      const value = objects.get(key);
      if (value == null) return null;
      return {
        async text() {
          return value;
        },
      };
    },
    async put(key, body) {
      objects.set(key, body);
    },
  };
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
  assert.equal(attributes["session.id"], "session_test");
  assert.equal(attributes["attribution.source"], "docs");
  assert.equal(attributes["attribution.medium"], "acceptance");
  assert.equal(attributes["attribution.campaign"], "vs5");
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
        async get() {
          return null;
        },
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
  assert.equal(stateWrites.length, 2);

  const accountWrite = stateWrites.find(({ key }) =>
    key.startsWith("accounts/fixture_"),
  );

  assert.ok(accountWrite);
  assert.match(accountWrite.key, /^accounts\/fixture_/);

  const storedAccount = JSON.parse(accountWrite.body);
  assert.equal(storedAccount.actorAnonymousId, "anon_test");
  assert.equal(storedAccount.correlationId, "funnel_test");

  const record = recordFrom(captures[0]);
  const attributes = decodeAttributes(record.attributes);

  assert.equal(record.eventName, "account.created");
  assert.equal(attributes["actor.anonymous.id"], "anon_test");
  assert.equal(attributes["correlation.id"], "funnel_test");
  assert.equal(attributes["session.id"], "session_test");
  assert.equal(attributes["attribution.source"], "docs");
  assert.equal(attributes["attribution.medium"], "acceptance");
  assert.equal(attributes["attribution.campaign"], "vs5");
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


test("reloading the same funnel does not emit a second hero exposure", async () => {
  const captures = [];
  const state = fakeState();

  const makeRequest = () =>
    new Request("https://fixture.test/api/browser-event", {
      method: "POST",
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventName: "landing.hero.exposed",
      }),
    });

  const env = {
    ETLAYER_OTLP_ENDPOINT: "https://events.test/v1/logs",
    ETLAYER_INGEST_KEY: "test-key",
    STATE: state,
  };

  const options = {
    fetch: captureFetch(captures),
    eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };

  const first = await handleBrowserEvent(makeRequest(), env, options);
  const second = await handleBrowserEvent(makeRequest(), env, options);

  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(captures.length, 1);

  const firstBody = await first.json();
  const secondBody = await second.json();

  assert.equal(firstBody.eventId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(secondBody.eventId, firstBody.eventId);
  assert.equal(secondBody.duplicate, true);
});


test("VS3 invalid-account acceptance event omits only account.id from the contract", async () => {
  const captures = [];

  const request = new Request(
    "https://fixture.test/api/acceptance/invalid-account",
    {
      method: "POST",
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        causationId: "acceptance_cause_1",
      }),
    },
  );

  const response = await handleInvalidAccountAcceptance(
    request,
    {
      ETLAYER_OTLP_ENDPOINT: "https://events.test/v1/logs",
      ETLAYER_INGEST_KEY: "test-key",
    },
    {
      fetch: captureFetch(captures),
      eventId: "44444444-4444-4444-8444-444444444444",
      nowMs: 1_790_000_000_000,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(captures.length, 1);

  const record = recordFrom(captures[0]);
  const attributes = decodeAttributes(record.attributes);

  assert.equal(record.eventName, "account.created");
  assert.equal(attributes["etlayer.schema.version"], 1);
  assert.equal(attributes["actor.anonymous.id"], "anon_test");
  assert.equal(attributes["correlation.id"], "funnel_test");
  assert.equal(attributes["causation.id"], "acceptance_cause_1");
  assert.equal(attributes["etlayer.producer.kind"], "backend");
  assert.equal(
    attributes["etlayer.authority.kind"],
    "business_state",
  );
  assert.equal(attributes["account.id"], undefined);
  assert.equal(attributes["experiment.id"], undefined);

  const body = await response.json();
  assert.equal(body.intentionallyInvalid, true);
  assert.equal(body.missingAttribute, "account.id");
});


test("VS4 privacy acceptance emits a valid authoritative account event with sensitive test fields", async () => {
  const captures = [];
  const stateWrites = [];

  const request = new Request(
    "https://fixture.test/api/acceptance/privacy-account",
    {
      method: "POST",
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        causationId: "privacy_cause_1",
      }),
    },
  );

  const response = await handlePrivacyAccountAcceptance(
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
      eventId: "55555555-5555-4555-8555-555555555555",
      accountId: "fixture_privacy_test",
      nowMs: 1_790_000_000_000,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(stateWrites.length, 1);
  assert.equal(captures.length, 1);

  const attributes = decodeAttributes(
    recordFrom(captures[0]).attributes,
  );

  assert.equal(attributes["etlayer.schema.version"], 1);
  assert.equal(attributes["account.id"], "fixture_privacy_test");
  assert.equal(attributes["correlation.id"], "funnel_test");
  assert.equal(attributes["causation.id"], "privacy_cause_1");
  assert.equal(attributes["etlayer.producer.kind"], "backend");
  assert.equal(
    attributes["etlayer.authority.kind"],
    "business_state",
  );
  assert.equal(
    attributes["user.email"],
    "acceptance@example.test",
  );
  assert.equal(
    attributes["auth.token"],
    "acceptance-secret-do-not-store",
  );

  const body = await response.json();
  assert.equal(body.privacyAcceptance, true);
  assert.equal(body.expectedCanonicalField, "user.email");
  assert.equal(body.expectedIngestDrop, "auth.token");
  assert.equal(body.expectedDeliveryDrop, "user.email");
});


test("VS5 identity acceptance preserves anonymous, session, user, account, and attribution continuity", async () => {
  const captures = [];
  const stateWrites = [];

  const request = new Request(
    "https://fixture.test/api/acceptance/identity-flow",
    {
      method: "POST",
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        causationId: "hero_event_1",
      }),
    },
  );

  const response = await handleIdentityFlowAcceptance(
    request,
    {
      ETLAYER_OTLP_ENDPOINT: "https://events.test/v1/logs",
      ETLAYER_INGEST_KEY: "test-key",
      STATE: {
        async put(key, body) {
          stateWrites.push({ key, body });
        },
      },
    },
    {
      fetch: captureFetch(captures),
      userId: "user_test",
      accountId: "account_test",
      linkEventId: "66666666-6666-4666-8666-666666666666",
      accountEventId: "77777777-7777-4777-8777-777777777777",
      nowMs: 1_790_000_000_000,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(stateWrites.length, 2);
  assert.equal(captures.length, 2);

  const linked = recordFrom(captures[0]);
  const linkedAttrs = decodeAttributes(linked.attributes);
  assert.equal(linked.eventName, "identity.linked");
  assert.equal(linkedAttrs["actor.anonymous.id"], "anon_test");
  assert.equal(linkedAttrs["user.id"], "user_test");
  assert.equal(linkedAttrs["account.id"], "account_test");
  assert.equal(linkedAttrs["session.id"], "session_test");
  assert.equal(linkedAttrs["correlation.id"], "funnel_test");
  assert.equal(linkedAttrs["causation.id"], "hero_event_1");
  assert.equal(linkedAttrs["attribution.source"], "docs");
  assert.equal(linkedAttrs["attribution.medium"], "acceptance");
  assert.equal(linkedAttrs["attribution.campaign"], "vs5");

  const account = recordFrom(captures[1]);
  const accountAttrs = decodeAttributes(account.attributes);
  assert.equal(account.eventName, "account.created");
  assert.equal(accountAttrs["user.id"], "user_test");
  assert.equal(accountAttrs["actor.anonymous.id"], "anon_test");
  assert.equal(accountAttrs["account.id"], "account_test");
  assert.equal(accountAttrs["session.id"], "session_test");
  assert.equal(
    accountAttrs["causation.id"],
    "66666666-6666-4666-8666-666666666666",
  );
  assert.equal(accountAttrs["attribution.campaign"], "vs5");

  const body = await response.json();
  assert.equal(body.anonymousId, "anon_test");
  assert.equal(body.sessionId, "session_test");
  assert.equal(body.userId, "user_test");
  assert.equal(body.accountId, "account_test");
  assert.equal(
    body.identityEventId,
    "66666666-6666-4666-8666-666666666666",
  );
  assert.equal(
    body.accountEventId,
    "77777777-7777-4777-8777-777777777777",
  );
  assert.deepEqual(body.attribution, {
    source: "docs",
    medium: "acceptance",
    campaign: "vs5",
  });
});

test("landing creates a stable session and persists attribution cookies", async () => {
  const response = await worker.fetch(
    new Request(
      "https://fixture.test/?run=run_test&utm_source=docs&utm_medium=acceptance&utm_campaign=vs5",
    ),
    {},
  );

  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);

  const joined = cookies.join("; ");
  assert.match(joined, /etel_session_id=session_/);
  assert.match(joined, /etel_attr_source=docs/);
  assert.match(joined, /etel_attr_medium=acceptance/);
  assert.match(joined, /etel_attr_campaign=vs5/);
});


test("VS5 agent acceptance preserves immediate actors and ordered delegation", async () => {
  const captures = [];
  const stateWrites = [];

  const request = new Request(
    "https://fixture.test/api/acceptance/agent-flow",
    {
      method: "POST",
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "usr_42",
        accountId: "account_42",
        causationId: "account_event_1",
      }),
    },
  );

  const response = await handleAgentDelegationAcceptance(
    request,
    {
      ETLAYER_OTLP_ENDPOINT: "https://events.test/v1/logs",
      ETLAYER_INGEST_KEY: "test-key",
      STATE: {
        async put(key, body) {
          stateWrites.push({ key, body });
        },
      },
    },
    {
      fetch: captureFetch(captures),
      directAgentId: "agent_parent",
      childAgentId: "agent_child",
      directTurnId: "turn_17",
      childTurnId: "turn_18",
      directToolCallId: "call_parent",
      childToolCallId: "call_child",
      directEventId: "88888888-8888-4888-8888-888888888888",
      childEventId: "99999999-9999-4999-8999-999999999999",
      nowMs: 1_790_000_000_000,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(stateWrites.length, 2);
  assert.equal(captures.length, 2);

  const direct = recordFrom(captures[0]);
  const directAttrs = decodeAttributes(direct.attributes);
  assert.equal(direct.eventName, "agent.tool.call");
  assert.equal(directAttrs["actor.type"], "agent");
  assert.equal(directAttrs["actor.id"], "agent_parent");
  assert.equal(directAttrs["user.id"], "usr_42");
  assert.equal(directAttrs["account.id"], "account_42");
  assert.equal(directAttrs["session.id"], "session_test");
  assert.equal(
    directAttrs["delegation.0.relationship"],
    "on_behalf_of",
  );
  assert.equal(
    directAttrs["delegation.0.principal.type"],
    "user",
  );
  assert.equal(
    directAttrs["delegation.0.principal.id"],
    "usr_42",
  );
  assert.equal(directAttrs["agent.turn.id"], "turn_17");
  assert.equal(directAttrs["agent.tool_call.id"], "call_parent");
  assert.equal(directAttrs["causation.id"], "account_event_1");

  const child = recordFrom(captures[1]);
  const childAttrs = decodeAttributes(child.attributes);
  assert.equal(child.eventName, "agent.subagent.tool.call");
  assert.equal(childAttrs["actor.type"], "agent");
  assert.equal(childAttrs["actor.id"], "agent_child");
  assert.equal(childAttrs["user.id"], "usr_42");
  assert.equal(
    childAttrs["delegation.0.relationship"],
    "delegated_by",
  );
  assert.equal(
    childAttrs["delegation.0.principal.type"],
    "agent",
  );
  assert.equal(
    childAttrs["delegation.0.principal.id"],
    "agent_parent",
  );
  assert.equal(
    childAttrs["delegation.1.relationship"],
    "on_behalf_of",
  );
  assert.equal(
    childAttrs["delegation.1.principal.type"],
    "user",
  );
  assert.equal(
    childAttrs["delegation.1.principal.id"],
    "usr_42",
  );
  assert.equal(
    childAttrs["causation.id"],
    "88888888-8888-4888-8888-888888888888",
  );

  const body = await response.json();
  assert.equal(body.userId, "usr_42");
  assert.equal(body.accountId, "account_42");
  assert.equal(body.directAgentId, "agent_parent");
  assert.equal(body.childAgentId, "agent_child");
  assert.equal(
    body.directEventId,
    "88888888-8888-4888-8888-888888888888",
  );
  assert.equal(
    body.childEventId,
    "99999999-9999-4999-8999-999999999999",
  );
});


test("VS6 browser events prefer the browser ingest credential over legacy", async () => {
  const calls = [];

  const response = await handleBrowserEvent(
    new Request("https://fixture.test/api/browser-event", {
      method: "POST",
      headers: {
        cookie: cookieHeader(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventName: "landing.hero.exposed",
      }),
    }),
    {
      ETLAYER_OTLP_ENDPOINT: "https://events.test/v1/logs",
      ETLAYER_BROWSER_INGEST_KEY: "browser-key",
      ETLAYER_INGEST_KEY: "legacy-key",
      ETLAYER: {
        async fetch(request) {
          calls.push({
            authorization: request.headers.get("authorization"),
          });
          return new Response("{}", { status: 200 });
        },
      },
    },
  );

  assert.equal(response.status, 202);
  assert.equal(calls[0].authorization, "Bearer browser-key");
});

test("VS6 authority spoof uses the requested low-trust credential while claiming backend authority", async () => {
  for (const [profile, expectedAuthorization] of [
    ["browser", "Bearer browser-key"],
    ["agent-runtime", "Bearer agent-key"],
  ]) {
    const calls = [];

    const response = await handleAuthoritySpoofAcceptance(
      new Request(
        "https://fixture.test/api/acceptance/authority-spoof",
        {
          method: "POST",
          headers: {
            cookie: cookieHeader(),
            "content-type": "application/json",
          },
          body: JSON.stringify({ profile }),
        },
      ),
      {
        ETLAYER_OTLP_ENDPOINT: "https://events.test/v1/logs",
        ETLAYER_BROWSER_INGEST_KEY: "browser-key",
        ETLAYER_AGENT_INGEST_KEY: "agent-key",
        ETLAYER: {
          async fetch(request) {
            calls.push({
              authorization:
                request.headers.get("authorization"),
              body: JSON.parse(
                await request.clone().text(),
              ),
            });
            return new Response("{}", { status: 200 });
          },
        },
      },
      {
        eventId:
          profile === "browser"
            ? "88888888-8888-4888-8888-888888888888"
            : "99999999-9999-4999-8999-999999999999",
      },
    );

    assert.equal(response.status, 202);
    assert.equal(
      calls[0].authorization,
      expectedAuthorization,
    );

    const attributes = decodeAttributes(
      recordFrom(calls[0].body).attributes,
    );

    assert.equal(
      attributes["etlayer.producer.kind"],
      "backend",
    );
    assert.equal(
      attributes["etlayer.authority.kind"],
      "business_state",
    );
  }
});

const baseUrl = requiredEnv("ETLAYER_BASE_URL").replace(/\/$/, "");
const ingestKey = requiredEnv("ETLAYER_INGEST_KEY");
const eventId = crypto.randomUUID();
const runId = process.env.ETLAYER_TEST_RUN_ID || `smoke-${eventId}`;
const nowUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();

const payload = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "etlayer-smoke" } },
          { key: "deployment.environment.name", value: { stringValue: "acceptance" } },
        ],
      },
      scopeLogs: [
        {
          scope: { name: "etlayer.smoke", version: "0.1.0" },
          logRecords: [
            {
              eventName: "etlayer.acceptance.smoke",
              timeUnixNano: nowUnixNano,
              observedTimeUnixNano: nowUnixNano,
              attributes: [
                { key: "etlayer.event.id", value: { stringValue: eventId } },
                { key: "etlayer.test.run_id", value: { stringValue: runId } },
                { key: "user.id", value: { stringValue: `smoke-user-${runId}` } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const response = await fetch(`${baseUrl}/v1/logs`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${ingestKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(payload),
});

const responseText = await response.text();

if (!response.ok) {
  console.error(JSON.stringify({
    ok: false,
    status: response.status,
    body: responseText,
    eventId,
    runId,
  }));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  status: response.status,
  eventName: "etlayer.acceptance.smoke",
  eventId,
  runId,
}));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(2);
  }
  return value;
}

import { consumeEventBatch } from "./archive.js";
import { handleExportLogs } from "./otlp.js";
import { exportToPostHog } from "./posthog.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/v1/logs") {
      return handleExportLogs(request, env);
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(batch, env) {
    await consumeEventBatch(batch, env, {
      afterPersist: async (event, archiveResult) => {
        console.info("persisted ETLayer event", {
          eventId: event.id,
          eventName: event.eventName,
          archiveStatus: archiveResult.status,
          archiveKey: archiveResult.key,
        });

        const exportResult = await exportToPostHog(event, env);

        console.info("projected ETLayer event", {
          eventId: event.id,
          eventName: event.eventName,
          destination: "posthog",
          exportStatus: exportResult.status,
        });
      },
    });
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

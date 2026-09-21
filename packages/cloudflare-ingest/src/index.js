import { consumeEventBatch } from "./archive.js";
import { handleExportLogs } from "./otlp.js";
import { processPersistedEvent } from "./processing.js";
import { handlePostHogReplay, handleStatsigReplay } from "./replay-http.js";
import { handleRevalidate } from "./revalidate-http.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/v1/logs") {
      return handleExportLogs(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/_ops/replay/posthog"
    ) {
      return handlePostHogReplay(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/_ops/replay/statsig"
    ) {
      return handleStatsigReplay(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/_ops/revalidate"
    ) {
      return handleRevalidate(request, env);
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

        const processed = await processPersistedEvent(event, env, {
          sourceKey: archiveResult.key,
        });

        console.info("validated ETLayer event", {
          eventId: event.id,
          eventName: event.eventName,
          validationStatus: processed.validation.status,
          schemaVersion: processed.validation.schemaVersion,
          contractId: processed.validation.contractId,
          validationErrors: processed.validation.errors.length,
        });

        console.info("applied ETLayer privacy policy", {
          eventId: event.id,
          eventName: event.eventName,
          privacyStatus: processed.privacy.status,
          privacyPolicyVersion: processed.privacy.policyVersion,
          ingestPrivacyActions: processed.privacy.ingestActions.length,
          deliveryPrivacyActions: processed.privacy.deliveryActions.length,
        });

        console.info("resolved ETLayer identity", {
          eventId: event.id,
          eventName: event.eventName,
          identityStatus: processed.identity.status,
          primaryIdentityKind: processed.identity.primary.kind,
          primaryIdentityId: processed.identity.primary.id,
          identityTransition: processed.identity.transition?.kind || null,
        });

        for (const delivery of processed.deliveries) {
          console.info("projected ETLayer event", {
            eventId: event.id,
            eventName: event.eventName,
            destination: delivery.destination,
            exportStatus: delivery.status,
          });
        }
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

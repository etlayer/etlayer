import { authenticateProjectOperator } from "./operator-auth.js";
import {
  replayPostHogRange,
  replayStatsigRange,
  ReplayArchiveError,
  ReplayConfigurationError,
  ReplayValidationError,
} from "./replay.js";

const REPLAY_HANDLERS = {
  posthog: replayPostHogRange,
  statsig: replayStatsigRange,
};

export async function handlePostHogReplay(request, env, options = {}) {
  return handleDestinationReplay(
    request,
    env,
    "posthog",
    options,
  );
}

export async function handleStatsigReplay(request, env, options = {}) {
  return handleDestinationReplay(
    request,
    env,
    "statsig",
    options,
  );
}

export async function handleDestinationReplay(
  request,
  env,
  destination,
  options = {},
) {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return jsonResponse(
      { error: "content-type must be application/json" },
      415,
    );
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse(
      { error: "request body is not valid JSON" },
      400,
    );
  }

  if (
    typeof input?.projectId !== "string" ||
    input.projectId.length === 0
  ) {
    return jsonResponse(
      { error: "projectId is required" },
      400,
    );
  }

  const authenticate =
    options.authenticateProjectOperator ||
    authenticateProjectOperator;
  const authentication = await authenticate(
    request,
    env,
    input.projectId,
    { crypto: options.crypto },
  );

  if (!authentication.ok) {
    if (
      authentication.reason ===
      "operator_credential_not_configured"
    ) {
      return jsonResponse(
        { error: "operator credential is not configured for project" },
        503,
      );
    }

    if (authentication.reason === "unknown_project") {
      return jsonResponse(
        { error: "unknown project" },
        400,
      );
    }

    return jsonResponse(
      { error: "invalid operator credential for project" },
      401,
    );
  }

  try {
    const replay =
      options.replay ||
      REPLAY_HANDLERS[destination];

    if (!replay) {
      return jsonResponse(
        {
          error:
            `unsupported replay destination: ${destination}`,
        },
        404,
      );
    }

    const result = await replay(env, input, options);
    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof ReplayValidationError) {
      return jsonResponse({ error: error.message }, 400);
    }

    if (error instanceof ReplayConfigurationError) {
      return jsonResponse({ error: error.message }, 503);
    }

    if (error instanceof ReplayArchiveError) {
      return jsonResponse({ error: error.message }, 500);
    }

    console.error("failed to replay ETLayer events", {
      projectId: input?.projectId,
      destination,
      replayId: input?.replayId,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });

    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "replay delivery failed",
      },
      502,
    );
  }
}

function isJsonContentType(contentType) {
  if (!contentType) return false;
  return (
    contentType.split(";", 1)[0].trim().toLowerCase() ===
    "application/json"
  );
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

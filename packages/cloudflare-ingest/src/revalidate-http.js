import {
  revalidateArchivedEvent,
  RevalidationArchiveError,
  RevalidationConfigurationError,
  RevalidationNotFoundError,
  RevalidationValidationError,
} from "./revalidate.js";

export async function handleRevalidate(
  request,
  env,
  options = {},
) {
  if (!env.ETLAYER_REPLAY_KEY) {
    return jsonResponse(
      { error: "operator key is not configured" },
      503,
    );
  }

  if (
    request.headers.get("authorization") !==
    `Bearer ${env.ETLAYER_REPLAY_KEY}`
  ) {
    return jsonResponse(
      { error: "invalid operator credential" },
      401,
    );
  }

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

  try {
    const revalidate =
      options.revalidate || revalidateArchivedEvent;
    const result = await revalidate(env, input, options);
    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof RevalidationValidationError) {
      return jsonResponse({ error: error.message }, 400);
    }

    if (error instanceof RevalidationConfigurationError) {
      return jsonResponse({ error: error.message }, 503);
    }

    if (error instanceof RevalidationNotFoundError) {
      return jsonResponse({ error: error.message }, 404);
    }

    if (error instanceof RevalidationArchiveError) {
      return jsonResponse({ error: error.message }, 500);
    }

    console.error("failed to revalidate ETLayer event", {
      sourceKey: input?.sourceKey,
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
            : "revalidation failed",
      },
      500,
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

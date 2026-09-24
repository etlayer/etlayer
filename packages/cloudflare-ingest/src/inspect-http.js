import { inspectEventState } from "./event-inspection.js";
import { authenticateProjectOperator } from "./operator-auth.js";
import { validateProjectId } from "./project-config.js";

export async function handleEventInspect(
  request,
  env,
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

  let projectId;
  try {
    projectId = validateProjectId(input?.projectId);
  } catch {
    return jsonResponse(
      { error: "projectId must be a valid project slug" },
      400,
    );
  }

  const eventId = input?.eventId;
  if (
    typeof eventId !== "string" ||
    eventId.trim() === ""
  ) {
    return jsonResponse(
      { error: "eventId is required" },
      400,
    );
  }

  const authenticate =
    options.authenticateProjectOperator ||
    authenticateProjectOperator;
  const authentication = await authenticate(
    request,
    env,
    projectId,
    { crypto: options.crypto },
  );

  if (!authentication.ok) {
    if (
      authentication.reason ===
      "operator_credential_not_configured"
    ) {
      return jsonResponse(
        {
          error:
            "operator credential is not configured for project",
        },
        503,
      );
    }

    if (authentication.reason === "unknown_project") {
      return jsonResponse(
        { error: "unknown project" },
        404,
      );
    }

    return jsonResponse(
      {
        error:
          "invalid operator credential for project",
      },
      401,
    );
  }

  try {
    return jsonResponse(
      await inspectEventState(
        env.ARCHIVE,
        projectId,
        eventId,
      ),
      200,
    );
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "project configuration unavailable",
      },
      503,
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
      "content-type":
        "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

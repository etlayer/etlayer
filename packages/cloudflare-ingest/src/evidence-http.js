import { authenticateProjectOperator } from "./operator-auth.js";
import { requireProjectKey } from "./project-scope.js";

export async function handleEvidenceRead(
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
  const authentication = authenticate(
    request,
    env,
    input.projectId,
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

  let key;
  try {
    key = requireProjectKey(input.projectId, input.key);
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "invalid project evidence key",
      },
      400,
    );
  }

  if (!env.ARCHIVE || typeof env.ARCHIVE.get !== "function") {
    return jsonResponse(
      { error: "archive bucket is not configured" },
      503,
    );
  }

  const object = await env.ARCHIVE.get(key);
  if (!object) {
    return jsonResponse(
      { error: "evidence not found", key },
      404,
    );
  }

  const text =
    typeof object.text === "function"
      ? await object.text()
      : object.body != null
        ? await new Response(object.body).text()
        : null;

  if (text == null) {
    return jsonResponse(
      { error: "evidence has no readable body", key },
      500,
    );
  }

  return new Response(text, {
    status: 200,
    headers: {
      "content-type":
        object.httpMetadata?.contentType ||
        "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
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

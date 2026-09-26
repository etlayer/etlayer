import {
  authenticateProjectOperator,
} from "./operator-auth.js";
import {
  GovernanceMetricsConfigurationError,
  GovernanceMetricsLimitError,
  GovernanceMetricsValidationError,
  buildGovernanceMetrics,
} from "./governance-metrics.js";

export async function handleGovernanceMetrics(
  request,
  env,
  options = {},
) {
  if (
    !isJsonContentType(
      request.headers.get("content-type"),
    )
  ) {
    return jsonResponse(
      {
        error:
          "content-type must be application/json",
      },
      415,
    );
  }

  let input;

  try {
    input = await request.json();
  } catch {
    return jsonResponse(
      {
        error:
          "request body is not valid JSON",
      },
      400,
    );
  }

  const projectId = input?.projectId;

  if (
    typeof projectId !== "string" ||
    projectId.trim() === ""
  ) {
    return jsonResponse(
      {
        error:
          "projectId is required",
      },
      400,
    );
  }

  const authenticate =
    options.authenticateProjectOperator ||
    authenticateProjectOperator;
  const authentication =
    await authenticate(
      request,
      env,
      projectId,
      {
        crypto:
          options.crypto,
      },
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

    if (
      authentication.reason ===
      "unknown_project"
    ) {
      return jsonResponse(
        {
          error:
            "unknown project",
        },
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
    const build =
      options.buildGovernanceMetrics ||
      buildGovernanceMetrics;

    return jsonResponse(
      await build(
        env,
        input,
        options,
      ),
      200,
    );
  } catch (error) {
    if (
      error instanceof
        GovernanceMetricsValidationError ||
      error instanceof
        GovernanceMetricsLimitError
    ) {
      return jsonResponse(
        {
          error:
            error.message,
        },
        400,
      );
    }

    if (
      error instanceof
        GovernanceMetricsConfigurationError
    ) {
      return jsonResponse(
        {
          error:
            error.message,
        },
        503,
      );
    }

    throw error;
  }
}

function isJsonContentType(
  contentType,
) {
  if (!contentType) return false;

  return (
    contentType
      .split(";", 1)[0]
      .trim()
      .toLowerCase() ===
    "application/json"
  );
}

function jsonResponse(
  body,
  status,
) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        "cache-control":
          "no-store",
      },
    },
  );
}

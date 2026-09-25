import {
  authenticateProjectOperator,
} from "./operator-auth.js";
import {
  GovernanceManifestConfigurationError,
  GovernanceManifestValidationError,
  GovernancePlanArchiveError,
  GovernancePlanConfigurationError,
  GovernancePlanValidationError,
  planGovernanceManifest,
} from "./governance-plan.js";

export async function handleGovernancePlan(
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
      { error: "projectId is required" },
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

    if (
      authentication.reason ===
      "unknown_project"
    ) {
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
    const plan =
      options.planGovernanceManifest ||
      planGovernanceManifest;

    return jsonResponse(
      await plan(
        env,
        input,
        options,
      ),
      200,
    );
  } catch (error) {
    if (
      error instanceof
        GovernanceManifestValidationError ||
      error instanceof
        GovernancePlanValidationError
    ) {
      return jsonResponse(
        { error: error.message },
        400,
      );
    }

    if (
      error instanceof
        GovernanceManifestConfigurationError ||
      error instanceof
        GovernancePlanConfigurationError
    ) {
      return jsonResponse(
        { error: error.message },
        503,
      );
    }

    if (
      error instanceof
        GovernancePlanArchiveError
    ) {
      return jsonResponse(
        { error: error.message },
        500,
      );
    }

    throw error;
  }
}

function isJsonContentType(contentType) {
  if (!contentType) return false;

  return (
    contentType
      .split(";", 1)[0]
      .trim()
      .toLowerCase() ===
    "application/json"
  );
}

function jsonResponse(body, status) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

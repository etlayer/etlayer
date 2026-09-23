import {
  operatorSecretEnv,
  projectConfiguration,
} from "./project-config.js";

export function authenticateProjectOperator(
  request,
  env,
  projectId,
) {
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    !projectConfiguration(projectId)
  ) {
    return {
      ok: false,
      reason: "unknown_project",
    };
  }

  const secretEnv = operatorSecretEnv(projectId);
  const secret = env[secretEnv];

  if (!secret) {
    return {
      ok: false,
      reason: "operator_credential_not_configured",
    };
  }

  if (
    request.headers.get("authorization") !==
    `Bearer ${secret}`
  ) {
    return {
      ok: false,
      reason: "invalid_operator_credential",
    };
  }

  return {
    ok: true,
    projectId,
  };
}

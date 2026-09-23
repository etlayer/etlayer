import {
  operatorSecretEnv,
  projectConfiguration,
  validateProjectId,
} from "./project-config.js";
import {
  credentialFingerprint,
  readOperatorCredential,
  readRegistryProject,
} from "./registry.js";

export async function authenticateProjectOperator(
  request,
  env,
  projectId,
  options = {},
) {
  try {
    validateProjectId(projectId);
  } catch {
    return {
      ok: false,
      reason: "unknown_project",
    };
  }

  const token = bearerToken(
    request.headers.get("authorization"),
  );

  if (!token) {
    return {
      ok: false,
      reason: "invalid_operator_credential",
    };
  }

  const staticProject = projectConfiguration(projectId);
  if (staticProject) {
    const secretEnv = operatorSecretEnv(projectId);
    const secret = secretEnv ? env[secretEnv] : null;

    if (!secret) {
      return {
        ok: false,
        reason: "operator_credential_not_configured",
      };
    }

    if (token !== secret) {
      return {
        ok: false,
        reason: "invalid_operator_credential",
      };
    }

    return {
      ok: true,
      projectId,
      source: "static",
    };
  }

  if (!env.ARCHIVE || typeof env.ARCHIVE.get !== "function") {
    return {
      ok: false,
      reason: "operator_credential_not_configured",
    };
  }

  const project = await readRegistryProject(
    env.ARCHIVE,
    projectId,
  );

  if (!project || project.status !== "active") {
    return {
      ok: false,
      reason: "unknown_project",
    };
  }

  const fingerprint = await credentialFingerprint(
    token,
    options.crypto || globalThis.crypto,
  );
  const credential = await readOperatorCredential(
    env.ARCHIVE,
    fingerprint,
  );

  if (
    !credential ||
    credential.status !== "active" ||
    credential.projectId !== projectId ||
    project.operatorFingerprint !== fingerprint
  ) {
    return {
      ok: false,
      reason: "invalid_operator_credential",
    };
  }

  return {
    ok: true,
    projectId,
    source: "registry",
  };
}

function bearerToken(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^Bearer (.+)$/);
  return match?.[1] || null;
}

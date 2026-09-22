import { configuredProjects } from "./project-config.js";

export function authenticateIngest(request, env) {
  const authorization = request.headers.get("authorization");
  const token = bearerToken(authorization);

  if (!token) {
    return {
      ok: false,
      reason: "invalid_ingest_credential",
    };
  }

  let configured = false;

  for (const project of configuredProjects()) {
    for (const profile of project.profiles) {
      const secret = env[profile.secretEnv];
      if (!secret) continue;

      configured = true;

      if (token === secret) {
        return {
          ok: true,
          provenance: provenanceFor(project.id, profile),
        };
      }
    }
  }

  return {
    ok: false,
    reason: configured
      ? "invalid_ingest_credential"
      : "ingest_credentials_not_configured",
  };
}

export function stampTrustedProvenance(event, provenance) {
  validateProvenance(provenance);

  return {
    ...event,
    provenance: structuredClone(provenance),
  };
}

function provenanceFor(projectId, profile) {
  return {
    version: 2,
    projectId,
    profileId: profile.profileId,
    authentication: "bearer_profile",
    producer: {
      kind: profile.producerKind,
    },
    allowedAuthorityKinds: [...profile.allowedAuthorityKinds],
  };
}

function bearerToken(value) {
  if (typeof value !== "string") return null;

  const match = value.match(/^Bearer (.+)$/);
  return match?.[1] || null;
}

function validateProvenance(provenance) {
  const legacy =
    provenance?.version === 1 &&
    typeof provenance.profileId === "string" &&
    provenance.authentication === "bearer_profile" &&
    typeof provenance.producer?.kind === "string" &&
    Array.isArray(provenance.allowedAuthorityKinds);

  const projectScoped =
    provenance?.version === 2 &&
    typeof provenance.projectId === "string" &&
    provenance.projectId.length > 0 &&
    typeof provenance.profileId === "string" &&
    provenance.authentication === "bearer_profile" &&
    typeof provenance.producer?.kind === "string" &&
    Array.isArray(provenance.allowedAuthorityKinds);

  if (!legacy && !projectScoped) {
    throw new ProvenanceConfigurationError(
      "trusted provenance is invalid",
    );
  }
}

export class ProvenanceConfigurationError extends Error {}

const PROFILES = [
  {
    secretEnv: "ETLAYER_BROWSER_INGEST_KEY",
    profileId: "browser",
    producerKind: "browser",
    allowedAuthorityKinds: ["interaction"],
  },
  {
    secretEnv: "ETLAYER_BACKEND_INGEST_KEY",
    profileId: "backend",
    producerKind: "backend",
    allowedAuthorityKinds: ["business_state"],
  },
  {
    secretEnv: "ETLAYER_AGENT_INGEST_KEY",
    profileId: "agent-runtime",
    producerKind: "agent_runtime",
    allowedAuthorityKinds: ["agent_runtime"],
  },
  {
    secretEnv: "ETLAYER_INGEST_KEY",
    profileId: "legacy",
    producerKind: "legacy",
    allowedAuthorityKinds: [],
  },
];

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

  for (const profile of PROFILES) {
    const secret = env[profile.secretEnv];
    if (!secret) continue;

    configured = true;

    if (token === secret) {
      return {
        ok: true,
        provenance: provenanceFor(profile),
      };
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

function provenanceFor(profile) {
  return {
    version: 1,
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
  if (
    !provenance ||
    provenance.version !== 1 ||
    typeof provenance.profileId !== "string" ||
    provenance.authentication !== "bearer_profile" ||
    typeof provenance.producer?.kind !== "string" ||
    !Array.isArray(provenance.allowedAuthorityKinds)
  ) {
    throw new ProvenanceConfigurationError(
      "trusted provenance is invalid",
    );
  }
}

export class ProvenanceConfigurationError extends Error {}

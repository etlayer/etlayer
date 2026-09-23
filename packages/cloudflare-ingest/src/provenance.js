import { configuredProjects } from "./project-config.js";
import {
  credentialFingerprint,
  readProducerCredential,
  readRegistryProducer,
} from "./registry.js";

export async function authenticateIngest(
  request,
  env,
  options = {},
) {
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
          provenance: provenanceFor(
            project.id,
            profile,
          ),
        };
      }
    }
  }

  if (
    env.ARCHIVE &&
    typeof env.ARCHIVE.get === "function"
  ) {
    configured = true;
    const cryptoImpl =
      options.crypto || globalThis.crypto;
    const fingerprint = await credentialFingerprint(
      token,
      cryptoImpl,
    );
    const credential = await readProducerCredential(
      env.ARCHIVE,
      fingerprint,
    );

    if (
      credential &&
      credential.status === "active"
    ) {
      const producer = await readRegistryProducer(
        env.ARCHIVE,
        credential.projectId,
        credential.producerId,
      );

      if (
        producer &&
        producer.status === "active" &&
        producer.credentialFingerprint === fingerprint
      ) {
        return {
          ok: true,
          provenance: provenanceFor(
            producer.projectId,
            producer,
          ),
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
    allowedAuthorityKinds: [
      ...profile.allowedAuthorityKinds,
    ],
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

import { decodeEventAttributes } from "./event-contracts.js";

export function evaluateEventAuthority(event) {
  validateManagedEvent(event);

  const attributes = decodeEventAttributes(event);
  const producerKind = stringValue(
    attributes["etlayer.producer.kind"],
  );
  const authorityKind = stringValue(
    attributes["etlayer.authority.kind"],
  );

  if (!producerKind && !authorityKind) {
    return {
      status: "not_applicable",
      profileId: event.provenance?.profileId || null,
      trustedProducerKind:
        event.provenance?.producer?.kind || null,
      claim: {
        producerKind: null,
        authorityKind: null,
      },
      errors: [],
    };
  }

  const errors = [];
  const provenance = event.provenance;

  if (!validProvenance(provenance)) {
    errors.push({
      code: "trusted_provenance_missing",
    });
  } else {
    if (!producerKind) {
      errors.push({
        code: "producer_kind_claim_missing",
      });
    } else if (producerKind !== provenance.producer.kind) {
      errors.push({
        code: "producer_kind_mismatch",
        claimed: producerKind,
        trusted: provenance.producer.kind,
      });
    }

    if (!authorityKind) {
      errors.push({
        code: "authority_kind_claim_missing",
      });
    } else if (
      !provenance.allowedAuthorityKinds.includes(
        authorityKind,
      )
    ) {
      errors.push({
        code: "authority_not_allowed",
        authorityKind,
      });
    }
  }

  return {
    status: errors.length === 0 ? "allowed" : "blocked",
    profileId: provenance?.profileId || null,
    trustedProducerKind:
      provenance?.producer?.kind || null,
    claim: {
      producerKind,
      authorityKind,
    },
    errors,
  };
}

function validProvenance(provenance) {
  return (
    provenance &&
    provenance.version === 1 &&
    typeof provenance.profileId === "string" &&
    typeof provenance.producer?.kind === "string" &&
    Array.isArray(provenance.allowedAuthorityKinds)
  );
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0
    ? value
    : null;
}

function validateManagedEvent(event) {
  if (
    !event ||
    typeof event !== "object" ||
    typeof event.id !== "string" ||
    typeof event.eventName !== "string"
  ) {
    throw new AuthorityPolicyError(
      "managed event id and eventName are required",
    );
  }
}

export class AuthorityPolicyError extends Error {}

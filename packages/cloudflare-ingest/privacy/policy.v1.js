export const PRIVACY_POLICY_VERSION = 1;

const EXACT_CLASSIFICATIONS = new Map([
  ["user.email", "direct_identifier"],
  ["user.phone", "direct_identifier"],
  ["user.id", "pseudonymous_identifier"],
  ["actor.anonymous.id", "pseudonymous_identifier"],
  ["account.id", "pseudonymous_identifier"],
  ["session.id", "pseudonymous_identifier"],
  ["correlation.id", "operational"],
  ["causation.id", "operational"],
  ["etlayer.event.id", "operational"],
  ["etlayer.schema.version", "operational"],
  ["actor.type", "operational"],
  ["actor.id", "pseudonymous_identifier"],
  ["agent.turn.id", "operational"],
  ["agent.tool_call.id", "operational"],
]);

const SECRET_PART =
  /(^|[._-])(authorization|password|passwd|secret|token|cookie|set-cookie)([._-]|$)/i;

export function classifyAttribute(attribute) {
  if (typeof attribute !== "string" || attribute.length === 0) {
    return "unclassified";
  }

  if (SECRET_PART.test(attribute)) {
    return "secret";
  }

  const exact = EXACT_CLASSIFICATIONS.get(attribute);
  if (exact) return exact;

  if (/^delegation\.\d+\.principal\.id$/.test(attribute)) {
    return "pseudonymous_identifier";
  }

  if (/^delegation\.\d+\.(relationship|principal\.type|reason|reference)$/.test(attribute)) {
    return "operational";
  }

  if (
    attribute.startsWith("experiment.") ||
    attribute.startsWith("page.") ||
    attribute.startsWith("cta.") ||
    attribute.startsWith("attribution.")
  ) {
    return "product_context";
  }

  return "unclassified";
}

export function ingestActionFor(classification) {
  return classification === "secret" ? "drop" : "preserve";
}

export function deliveryActionFor(classification) {
  return classification === "secret" ||
    classification === "direct_identifier"
    ? "drop"
    : "pass";
}

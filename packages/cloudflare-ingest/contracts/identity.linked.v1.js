export default {
  id: "identity.linked@1",
  eventName: "identity.linked",
  version: 1,
  required: {
    "actor.anonymous.id": { type: "string" },
    "user.id": { type: "string" },
    "account.id": { type: "string" },
    "session.id": { type: "string" },
    "correlation.id": { type: "string" },
    "causation.id": { type: "string" },
    "etlayer.producer.kind": { type: "string", const: "backend" },
    "etlayer.authority.kind": { type: "string", const: "business_state" },
  },
  forbidden: [],
};

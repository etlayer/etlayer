export default {
  id: "account.created@1",
  eventName: "account.created",
  version: 1,
  required: {
    "actor.anonymous.id": { type: "string" },
    "account.id": { type: "string" },
    "correlation.id": { type: "string" },
    "causation.id": { type: "string" },
    "etlayer.producer.kind": { type: "string", const: "backend" },
    "etlayer.authority.kind": { type: "string", const: "business_state" },
  },
  forbidden: [
    "experiment.id",
    "experiment.variant",
  ],
};

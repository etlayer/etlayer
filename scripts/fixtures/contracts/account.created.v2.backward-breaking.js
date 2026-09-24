export default {
  id: "account.created@2",
  eventName: "account.created",
  version: 2,
  required: {
    "actor.anonymous.id": { type: "string" },
    "account.id": { type: "integer" },
    "correlation.id": { type: "string" },
    "causation.id": { type: "string" },
    "plan.id": { type: "string" },
    "etlayer.producer.kind": {
      type: "string",
      const: "backend",
    },
    "etlayer.authority.kind": {
      type: "string",
      const: "business_state",
    },
  },
  forbidden: [
    "experiment.id",
    "experiment.variant",
  ],
};

export default {
  id: "landing.hero.exposed@1",
  eventName: "landing.hero.exposed",
  version: 1,
  required: {
    "actor.anonymous.id": { type: "string" },
    "correlation.id": { type: "string" },
    "etlayer.producer.kind": { type: "string", const: "browser" },
    "etlayer.authority.kind": { type: "string", const: "interaction" },
    "experiment.id": { type: "string" },
    "experiment.variant": { type: "string" },
  },
  forbidden: [],
};

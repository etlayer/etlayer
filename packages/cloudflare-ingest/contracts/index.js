import agentSubagentToolCallV1 from "./agent.subagent.tool.call.v1.js";
import agentToolCallV1 from "./agent.tool.call.v1.js";
import accountCreatedV1 from "./account.created.v1.js";
import heroCtaClickedV1 from "./landing.hero.cta_clicked.v1.js";
import heroExposedV1 from "./landing.hero.exposed.v1.js";
import identityLinkedV1 from "./identity.linked.v1.js";

const CONTRACTS = [
  agentToolCallV1,
  agentSubagentToolCallV1,
  heroExposedV1,
  heroCtaClickedV1,
  accountCreatedV1,
  identityLinkedV1,
];

const CONTRACTS_BY_KEY = new Map(
  CONTRACTS.map((contract) => [
    contractKey(contract.eventName, contract.version),
    contract,
  ]),
);

export function findContract(eventName, version) {
  return CONTRACTS_BY_KEY.get(contractKey(eventName, version)) || null;
}

export function listContracts() {
  return [...CONTRACTS];
}

function contractKey(eventName, version) {
  return `${eventName}@${version}`;
}

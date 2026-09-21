import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAttribute,
  deliveryActionFor,
  ingestActionFor,
} from "../privacy/policy.v1.js";

test("classifies reference privacy fields", () => {
  assert.equal(classifyAttribute("user.email"), "direct_identifier");
  assert.equal(classifyAttribute("user.id"), "pseudonymous_identifier");
  assert.equal(classifyAttribute("account.id"), "pseudonymous_identifier");
  assert.equal(classifyAttribute("correlation.id"), "operational");
  assert.equal(classifyAttribute("experiment.variant"), "product_context");
  assert.equal(classifyAttribute("attribution.campaign"), "product_context");
  assert.equal(classifyAttribute("custom.metric"), "unclassified");
});

test("classifies credential-like names as secret", () => {
  for (const key of [
    "auth.token",
    "authorization",
    "user.password",
    "api_secret",
    "cookie",
    "set-cookie",
  ]) {
    assert.equal(classifyAttribute(key), "secret", key);
  }
});

test("policy v1 drops secrets at ingest and direct identifiers at delivery", () => {
  assert.equal(ingestActionFor("secret"), "drop");
  assert.equal(ingestActionFor("direct_identifier"), "preserve");
  assert.equal(deliveryActionFor("secret"), "drop");
  assert.equal(deliveryActionFor("direct_identifier"), "drop");
  assert.equal(deliveryActionFor("pseudonymous_identifier"), "pass");
});

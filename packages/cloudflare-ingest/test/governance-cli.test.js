import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("governance CLI returns breaking exit code with stable JSON output", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-governance-manifest.mjs",
      "--file",
      "scripts/fixtures/governance/account.created.v2.backward-breaking.json",
      "--json",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");

  const output = JSON.parse(result.stdout);

  assert.equal(
    output.manifest.projectId,
    "governance-fixture",
  );
  assert.match(
    output.manifestDigest,
    /^[0-9a-f]{64}$/,
  );
  assert.equal(output.compatible, false);
  assert.equal(
    output.contracts[0]
      .compatibility.backward.violations
      .some(
        (violation) =>
          violation.code ===
            "required_attribute_added" &&
          violation.attribute ===
            "plan.id",
      ),
    true,
  );
});

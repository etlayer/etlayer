#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  analyzeContractCompatibility,
  ContractCompatibilityError,
} from "../packages/cloudflare-ingest/src/contract-compatibility.js";

const args = parseArgs(process.argv.slice(2));

try {
  const current = await loadContract(args.from);
  const proposed = await loadContract(args.to);

  const result = analyzeContractCompatibility(
    current,
    proposed,
    { mode: args.mode },
  );

  if (args.json) {
    process.stdout.write(
      JSON.stringify(result, null, 2) + "\n",
    );
  } else {
    printHuman(result);
  }

  process.exitCode = result.compatible ? 0 : 2;
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  process.stderr.write(
    "Contract compatibility check failed: " +
      message +
      "\n",
  );

  process.exitCode =
    error instanceof ContractCompatibilityError
      ? 1
      : 1;
}

function parseArgs(argv) {
  const result = {
    from: null,
    to: null,
    mode: "backward",
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--from") {
      result.from = argv[++i] || null;
      continue;
    }

    if (arg === "--to") {
      result.to = argv[++i] || null;
      continue;
    }

    if (arg === "--mode") {
      result.mode = argv[++i] || null;
      continue;
    }

    if (arg === "--json") {
      result.json = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      usage(0);
    }

    usage(1, "Unknown argument: " + arg);
  }

  if (!result.from || !result.to) {
    usage(
      1,
      "--from and --to contract module paths are required",
    );
  }

  return result;
}

async function loadContract(path) {
  const url = pathToFileURL(resolve(path)).href;
  const module = await import(url);

  if (!module.default) {
    throw new Error(
      "Contract module must default-export a contract: " +
        path,
    );
  }

  return module.default;
}

function printHuman(result) {
  const label =
    result.compatible ? "COMPATIBLE" : "BREAKING";

  process.stdout.write(
    [
      result.eventName +
        "@" +
        result.fromVersion +
        " -> @" +
        result.toVersion,
      "mode: " + result.mode,
      "result: " + label,
      "backward: " +
        (result.backward.compatible
          ? "compatible"
          : "breaking"),
      "forward: " +
        (result.forward.compatible
          ? "compatible"
          : "breaking"),
    ].join("\n") + "\n",
  );

  const violations =
    result.mode === "backward"
      ? result.backward.violations
      : result.mode === "forward"
        ? result.forward.violations
        : [
            ...result.backward.violations,
            ...result.forward.violations,
          ];

  for (const violation of violations) {
    process.stdout.write(
      "- " +
        violation.code +
        ": " +
        violation.attribute +
        "\n",
    );
  }
}

function usage(exitCode, error = null) {
  if (error) {
    process.stderr.write(error + "\n\n");
  }

  const output = [
    "Usage:",
    "  node scripts/check-contract-compatibility.mjs \\",
    "    --from <current-contract.js> \\",
    "    --to <proposed-contract.js> \\",
    "    [--mode backward|forward|full] [--json]",
    "",
    "Exit codes:",
    "  0 compatible",
    "  1 invalid input or execution error",
    "  2 breaking compatibility",
  ].join("\n") + "\n";

  (exitCode === 0
    ? process.stdout
    : process.stderr
  ).write(output);

  process.exit(exitCode);
}

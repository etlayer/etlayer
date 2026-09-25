#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  GovernanceManifestValidationError,
  GovernancePlanValidationError,
  checkGovernanceManifest,
} from "../packages/cloudflare-ingest/src/governance-plan.js";

const args = parseArgs(
  process.argv.slice(2),
);

try {
  const raw = await readFile(
    resolve(args.file),
    "utf8",
  );
  const manifest = JSON.parse(raw);
  const result =
    await checkGovernanceManifest(
      manifest,
    );

  if (args.json) {
    process.stdout.write(
      JSON.stringify(result, null, 2) +
        "\n",
    );
  } else {
    printHuman(result);
  }

  process.exitCode =
    result.compatible ? 0 : 2;
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  process.stderr.write(
    "Governance manifest check failed: " +
      message +
      "\n",
  );

  process.exitCode =
    error instanceof
      GovernanceManifestValidationError ||
    error instanceof
      GovernancePlanValidationError
      ? 1
      : 1;
}

function parseArgs(argv) {
  const result = {
    file: null,
    json: false,
  };

  for (
    let index = 0;
    index < argv.length;
    index += 1
  ) {
    const arg = argv[index];

    if (arg === "--file") {
      result.file =
        argv[++index] || null;
      continue;
    }

    if (arg === "--json") {
      result.json = true;
      continue;
    }

    if (
      arg === "--help" ||
      arg === "-h"
    ) {
      usage(0);
    }

    usage(
      1,
      "Unknown argument: " + arg,
    );
  }

  if (!result.file) {
    usage(
      1,
      "--file governance manifest path is required",
    );
  }

  return result;
}

function printHuman(result) {
  process.stdout.write(
    [
      "Governance manifest",
      "project: " +
        result.manifest.projectId,
      "digest: " +
        result.manifestDigest,
      "result: " +
        (result.compatible
          ? "COMPATIBLE"
          : "BREAKING"),
      "",
    ].join("\n"),
  );

  for (
    const contract of result.contracts
  ) {
    process.stdout.write(
      [
        contract.eventName +
          "@" +
          contract.currentVersion +
          " -> @" +
          contract.proposedVersion,
        "mode: " +
          contract.compatibilityMode,
        "result: " +
          (contract.compatibility
            .compatible
            ? "compatible"
            : "breaking"),
      ].join("\n") + "\n",
    );

    const violations =
      contract.compatibilityMode ===
      "backward"
        ? contract.compatibility
            .backward.violations
        : contract.compatibilityMode ===
            "forward"
          ? contract.compatibility
              .forward.violations
          : [
              ...contract.compatibility
                .backward.violations,
              ...contract.compatibility
                .forward.violations,
            ];

    for (
      const violation of violations
    ) {
      process.stdout.write(
        "- " +
          violation.code +
          ": " +
          violation.attribute +
          "\n",
      );
    }

    process.stdout.write("\n");
  }
}

function usage(
  exitCode,
  error = null,
) {
  if (error) {
    process.stderr.write(
      error + "\n\n",
    );
  }

  const output = [
    "Usage:",
    "  npm run governance:check -- --file <manifest.json> [--json]",
    "",
    "Exit codes:",
    "  0 all contract changes compatible",
    "  1 invalid manifest or execution error",
    "  2 one or more breaking changes",
  ].join("\n") + "\n";

  (
    exitCode === 0
      ? process.stdout
      : process.stderr
  ).write(output);

  process.exit(exitCode);
}

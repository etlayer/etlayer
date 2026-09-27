#!/usr/bin/env node

import process from "node:process";

import {
  generateProjectContractTypeScript,
} from "../packages/contract-tools/src/project-contract-generator.js";

async function main() {
  const args =
    parseArgs(
      process.argv.slice(2),
    );
  const operatorCredential =
    process.env
      .ETLAYER_OPERATOR_CREDENTIAL;

  if (
    !args.baseUrl ||
    !args.projectId ||
    !args.outDir
  ) {
    fail(
      "usage: npm run contract:generate:project -- --base-url <url> --project-id <id> --out-dir <directory>",
    );
  }

  if (!operatorCredential) {
    fail(
      "ETLAYER_OPERATOR_CREDENTIAL is required",
    );
  }

  try {
    const result =
      await generateProjectContractTypeScript(
        {
          baseUrl:
            args.baseUrl,
          projectId:
            args.projectId,
          operatorCredential,
          outDir:
            args.outDir,
        },
      );

    process.stdout.write(
      JSON.stringify(
        result,
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    fail(
      error instanceof Error
        ? error.message
        : "project contract generation failed",
    );
  }
}

function parseArgs(argv) {
  const result = {
    baseUrl: null,
    projectId: null,
    outDir: null,
  };

  for (
    let index = 0;
    index < argv.length;
    index += 1
  ) {
    const value =
      argv[index];
    const next =
      argv[index + 1] || null;

    if (
      value === "--base-url"
    ) {
      result.baseUrl = next;
      index += 1;
      continue;
    }

    if (
      value === "--project-id"
    ) {
      result.projectId = next;
      index += 1;
      continue;
    }

    if (
      value === "--out-dir"
    ) {
      result.outDir = next;
      index += 1;
      continue;
    }

    if (
      value === "--credential" ||
      value ===
        "--operator-credential"
    ) {
      fail(
        "operator credential must be supplied only through ETLAYER_OPERATOR_CREDENTIAL",
      );
    }

    fail(
      `unknown argument: ${value}`,
    );
  }

  return result;
}

function fail(message) {
  process.stderr.write(
    String(message) + "\n",
  );
  process.exit(1);
}

await main();

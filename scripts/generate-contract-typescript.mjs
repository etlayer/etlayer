#!/usr/bin/env node

import fs from "node:fs/promises";
import process from "node:process";

import {
  generateTypeScriptContractModule,
} from "../packages/cloudflare-ingest/src/typescript-contract-generator.js";

async function main() {
  const args = parseArgs(
    process.argv.slice(2),
  );

  if (!args.file) {
    fail(
      "usage: npm run contract:generate -- --file <artifact.json> [--out <generated.ts>]",
    );
  }

  let artifact;

  try {
    artifact = JSON.parse(
      await fs.readFile(
        args.file,
        "utf8",
      ),
    );
  } catch (error) {
    fail(
      error instanceof Error
        ? error.message
        : "failed to read contract artifact",
    );
  }

  let source;

  try {
    source =
      generateTypeScriptContractModule(
        artifact,
      );
  } catch (error) {
    fail(
      error instanceof Error
        ? error.message
        : "failed to generate TypeScript contract",
    );
  }

  if (args.out) {
    await fs.writeFile(
      args.out,
      source,
      "utf8",
    );
    return;
  }

  process.stdout.write(source);
}

function parseArgs(argv) {
  const result = {
    file: null,
    out: null,
  };

  for (
    let index = 0;
    index < argv.length;
    index += 1
  ) {
    const value = argv[index];

    if (value === "--file") {
      result.file =
        argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (value === "--out") {
      result.out =
        argv[index + 1] || null;
      index += 1;
      continue;
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

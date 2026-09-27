import {
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";

const forbidden = [
  "/_mgmt/",
  "/_ops/",
  "wrangler",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "ETLAYER_MANAGEMENT_KEY",
  "registry/",
  "packages/cloudflare-ingest",
  "R2",
];

const targets = [
  {
    path:
      "examples/external-consumer/run.mjs",
    forbidRepositoryImports: true,
  },
  {
    path:
      "scripts/generate-project-contract-typescript.mjs",
    forbidRepositoryImports: false,
  },
  {
    path:
      "packages/contract-tools/src/project-contract-generator.js",
    forbidRepositoryImports: false,
  },
];

for (const target of targets) {
  const source =
    readFileSync(
      resolve(target.path),
      "utf8",
    );
  const violations =
    forbidden.filter(
      (value) =>
        source.includes(value),
    );

  if (
    violations.length > 0
  ) {
    console.error(
      "External consumer boundary crossed by " +
        target.path +
        ": " +
        violations.join(", "),
    );
    process.exit(1);
  }

  if (
    !target.forbidRepositoryImports
  ) {
    continue;
  }

  const relativeImports = [
    ...source.matchAll(
      /from\s+["']([^"']+)["']/g,
    ),
  ]
    .map(
      (match) =>
        match[1],
    )
    .filter(
      (specifier) =>
        specifier.startsWith(".") ||
        specifier.startsWith("/"),
    );

  if (
    relativeImports.length > 0
  ) {
    console.error(
      "External consumer fixture must not import repository code:",
      relativeImports.join(", "),
    );
    process.exit(1);
  }
}

console.log(
  "External consumer boundary check passed",
);

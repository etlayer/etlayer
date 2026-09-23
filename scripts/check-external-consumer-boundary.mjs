import {
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";

const target = resolve(
  "examples/external-consumer/run.mjs",
);
const source = readFileSync(target, "utf8");

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

const violations = forbidden.filter((value) =>
  source.includes(value),
);

if (violations.length > 0) {
  console.error(
    "External consumer fixture crossed the public boundary:",
    violations.join(", "),
  );
  process.exit(1);
}

const relativeImports = [
  ...source.matchAll(
    /from\s+["']([^"']+)["']/g,
  ),
]
  .map((match) => match[1])
  .filter(
    (specifier) =>
      specifier.startsWith(".") ||
      specifier.startsWith("/"),
  );

if (relativeImports.length > 0) {
  console.error(
    "External consumer fixture must not import repository code:",
    relativeImports.join(", "),
  );
  process.exit(1);
}

console.log(
  "External consumer boundary check passed",
);

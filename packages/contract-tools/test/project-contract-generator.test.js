import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  spawnSync,
} from "node:child_process";
import test from "node:test";

import {
  ProjectContractGenerationError,
  generateProjectContractTypeScript,
} from "../src/project-contract-generator.js";

const BASE_URL =
  "https://events.test";
const PROJECT_ID =
  "project-a";
const CREDENTIAL =
  "etl_op_test";

test("project generation is deterministic and collision-safe", async (t) => {
  const root =
    await mkdtemp(
      path.join(
        os.tmpdir(),
        "etlayer-vs28-",
      ),
    );

  t.after(async () => {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  });

  const calls = [];
  const fetchImpl =
    fixtureFetch(
      calls,
      [
        {
          eventName:
            "account-created",
          version: 1,
        },
        {
          eventName:
            "account.created",
          version: 1,
        },
      ],
    );

  const first =
    path.join(
      root,
      "first",
    );
  const second =
    path.join(
      root,
      "second",
    );

  const firstResult =
    await generateProjectContractTypeScript(
      input(first),
      {
        fetchImpl,
      },
    );
  const secondResult =
    await generateProjectContractTypeScript(
      input(second),
      {
        fetchImpl,
      },
    );

  assert.equal(
    firstResult.contractCount,
    2,
  );
  assert.deepEqual(
    firstResult.files,
    secondResult.files,
  );
  assert.equal(
    new Set(
      firstResult.files,
    ).size,
    2,
  );

  const firstTree =
    await readTree(first);
  const secondTree =
    await readTree(second);

  assert.deepEqual(
    firstTree,
    secondTree,
  );

  const index =
    firstTree.get(
      "index.ts",
    );

  assert.match(
    index,
    /export \* as Contract_[a-f0-9]{64}_V1/,
  );

  const modules =
    firstResult.files.map(
      (filename) =>
        firstTree.get(
          filename,
        ),
    );

  assert.equal(
    modules.every(
      (source) =>
        !source.includes(
          "packages/cloudflare-ingest",
        ) &&
        !source.includes(
          " from ",
        ),
    ),
    true,
  );

  const accountFile =
    firstResult.files.find(
      (filename) =>
        firstTree
          .get(filename)
          .includes(
            'export const eventName = "account.created"',
          ),
    );
  assert.ok(accountFile);

  const executable =
    path.join(
      root,
      "validator.ts",
    );
  await writeFile(
    executable,
    firstTree.get(
      accountFile,
    ) +
      `
if (!validateAccountCreatedV1Attributes({
  "account.id": "account-1",
})) process.exit(7);

if (validateAccountCreatedV1Attributes({}))
  process.exit(8);
`,
    "utf8",
  );

  const execution =
    spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        executable,
      ],
      {
        encoding: "utf8",
      },
    );

  assert.equal(
    execution.status,
    0,
    execution.stderr,
  );

  assert.equal(
    calls.every(
      (call) =>
        call.authorization ===
        "Bearer " +
          CREDENTIAL,
    ),
    true,
  );
});

test("cross-origin artifact link is rejected before credential forwarding", async (t) => {
  const root =
    await mkdtemp(
      path.join(
        os.tmpdir(),
        "etlayer-vs28-guard-",
      ),
    );

  t.after(async () => {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  });

  const outDir =
    path.join(
      root,
      "generated",
    );
  await mkdir(outDir);
  await writeFile(
    path.join(
      outDir,
      "sentinel.txt",
    ),
    "keep",
    "utf8",
  );

  const calls = [];
  const fetchImpl =
    async (url, init) => {
      calls.push({
        url:
          String(url),
        authorization:
          init?.headers
            ?.authorization,
      });

      return jsonResponse(
        {
          apiVersion: "v1",
          kind:
            "ContractCatalog",
          projectId:
            PROJECT_ID,
          contracts: [
            {
              eventName:
                "account.created",
              version: 1,
              links: {
                self:
                  "https://evil.test/api/v1/projects/project-a/contracts/account.created/1",
              },
            },
          ],
        },
      );
    };

  await assert.rejects(
    () =>
      generateProjectContractTypeScript(
        input(outDir),
        {
          fetchImpl,
        },
      ),
    (error) =>
      error instanceof
        ProjectContractGenerationError &&
      /untrusted artifact URL/.test(
        error.message,
      ),
  );

  assert.equal(
    calls.length,
    1,
  );
  assert.equal(
    calls.some(
      ({ url }) =>
        url.startsWith(
          "https://evil.test",
        ),
    ),
    false,
  );
  assert.equal(
    await readFile(
      path.join(
        outDir,
        "sentinel.txt",
      ),
      "utf8",
    ),
    "keep",
  );
});

test("authentication failure publishes no partial output", async (t) => {
  const root =
    await mkdtemp(
      path.join(
        os.tmpdir(),
        "etlayer-vs28-auth-",
      ),
    );

  t.after(async () => {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  });

  const outDir =
    path.join(
      root,
      "generated",
    );

  await assert.rejects(
    () =>
      generateProjectContractTypeScript(
        input(outDir),
        {
          fetchImpl:
            async () =>
              jsonResponse(
                {
                  error: {
                    code:
                      "invalid_operator_credential",
                  },
                },
                401,
              ),
        },
      ),
    /invalid_operator_credential/,
  );

  await assert.rejects(
    () => stat(outDir),
    {
      code: "ENOENT",
    },
  );
});

test("duplicate catalog coordinates are rejected before artifact fetch", async (t) => {
  const root =
    await mkdtemp(
      path.join(
        os.tmpdir(),
        "etlayer-vs28-duplicate-",
      ),
    );

  t.after(async () => {
    await rm(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  });

  let calls = 0;

  await assert.rejects(
    () =>
      generateProjectContractTypeScript(
        input(
          path.join(
            root,
            "generated",
          ),
        ),
        {
          fetchImpl:
            async () => {
              calls += 1;
              return jsonResponse(
                {
                  apiVersion:
                    "v1",
                  kind:
                    "ContractCatalog",
                  projectId:
                    PROJECT_ID,
                  contracts: [
                    coordinate(
                      "account.created",
                      1,
                    ),
                    coordinate(
                      "account.created",
                      1,
                    ),
                  ],
                },
              );
            },
        },
      ),
    /duplicate contract coordinate/,
  );

  assert.equal(
    calls,
    1,
  );
});

function input(outDir) {
  return {
    baseUrl:
      BASE_URL,
    projectId:
      PROJECT_ID,
    operatorCredential:
      CREDENTIAL,
    outDir,
  };
}

function fixtureFetch(
  calls,
  coordinates,
) {
  return async (url, init) => {
    const href =
      String(url);

    calls.push({
      url: href,
      authorization:
        init?.headers
          ?.authorization,
    });

    if (
      href ===
      BASE_URL +
        "/api/v1/projects/project-a/contracts"
    ) {
      return jsonResponse({
        apiVersion: "v1",
        kind:
          "ContractCatalog",
        projectId:
          PROJECT_ID,
        contracts:
          coordinates
            .slice()
            .reverse()
            .map(
              ({ eventName, version }) =>
                coordinate(
                  eventName,
                  version,
                ),
            ),
      });
    }

    for (
      const {
        eventName,
        version,
      } of coordinates
    ) {
      const artifactUrl =
        BASE_URL +
        "/api/v1/projects/project-a/contracts/" +
        encodeURIComponent(
          eventName,
        ) +
        "/" +
        version;

      if (
        href === artifactUrl
      ) {
        return jsonResponse(
          artifact(
            eventName,
            version,
          ),
        );
      }
    }

    return jsonResponse(
      {
        error: {
          code:
            "not_found",
        },
      },
      404,
    );
  };
}

function coordinate(
  eventName,
  version,
) {
  return {
    eventName,
    version,
    source: "builtin",
    lifecycle: null,
    links: {
      self:
        BASE_URL +
        "/api/v1/projects/project-a/contracts/" +
        encodeURIComponent(
          eventName,
        ) +
        "/" +
        version,
    },
  };
}

function artifact(
  eventName,
  version,
) {
  return {
    apiVersion: "v1",
    kind: "Contract",
    projectId:
      PROJECT_ID,
    source: "builtin",
    contract: {
      id:
        eventName +
        "@" +
        version,
      eventName,
      version,
      required: {
        "account.id": {
          type: "string",
        },
      },
      forbidden: [],
    },
    lifecycle: null,
    links: {},
  };
}

function jsonResponse(
  body,
  status = 200,
) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "content-type":
          "application/json",
      },
    },
  );
}

async function readTree(
  directory,
) {
  const entries =
    (
      await readdir(
        directory,
      )
    ).sort();
  const tree =
    new Map();

  for (const entry of entries) {
    tree.set(
      entry,
      await readFile(
        path.join(
          directory,
          entry,
        ),
        "utf8",
      ),
    );
  }

  return tree;
}

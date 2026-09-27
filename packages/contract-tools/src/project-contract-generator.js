import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  generateTypeScriptContractModule,
} from "./typescript-contract-generator.js";

export async function generateProjectContractTypeScript(
  input,
  options = {},
) {
  const baseUrl =
    normalizeBaseUrl(
      input?.baseUrl,
    );
  const projectId =
    normalizeProjectId(
      input?.projectId,
    );
  const operatorCredential =
    requiredString(
      input?.operatorCredential,
      "operator credential",
    );
  const outDir =
    normalizeOutDir(
      input?.outDir,
    );
  const fetchImpl =
    options.fetchImpl ||
    globalThis.fetch;

  if (
    typeof fetchImpl !== "function"
  ) {
    throw new ProjectContractGenerationError(
      "fetch is not available",
    );
  }

  const catalogUrl =
    new URL(
      `/api/v1/projects/${encodeURIComponent(
        projectId,
      )}/contracts`,
      baseUrl.origin,
    );

  const catalog =
    await requestJson(
      catalogUrl,
      operatorCredential,
      fetchImpl,
      "contract catalog",
    );
  const coordinates =
    normalizeCatalog(
      catalog,
      projectId,
    );

  const files = [];
  const filenames = new Set();

  for (const coordinate of coordinates) {
    const artifactUrl =
      validateArtifactUrl(
        coordinate,
        baseUrl,
        projectId,
      );
    const artifact =
      await requestJson(
        artifactUrl,
        operatorCredential,
        fetchImpl,
        `${coordinate.eventName}@${coordinate.version}`,
      );

    validateArtifact(
      artifact,
      projectId,
      coordinate,
    );

    const filename =
      filenameFor(
        coordinate.eventName,
        coordinate.version,
      );

    if (filenames.has(filename)) {
      throw new ProjectContractGenerationError(
        `generated filename collision: ${filename}`,
      );
    }
    filenames.add(filename);

    files.push({
      filename,
      namespace:
        namespaceFor(
          coordinate.eventName,
          coordinate.version,
        ),
      source:
        generateTypeScriptContractModule(
          artifact,
        ),
    });
  }

  const indexSource =
    renderIndex(files);

  await publishOutput(
    outDir,
    [
      ...files.map(
        ({ filename, source }) => ({
          filename,
          source,
        }),
      ),
      {
        filename: "index.ts",
        source: indexSource,
      },
    ],
  );

  return {
    projectId,
    contractCount:
      coordinates.length,
    outDir,
    files:
      files.map(
        ({ filename }) => filename,
      ),
  };
}

function normalizeBaseUrl(value) {
  let url;

  try {
    url = new URL(
      requiredString(
        value,
        "base URL",
      ),
    );
  } catch {
    throw new ProjectContractGenerationError(
      "base URL must be a valid absolute URL",
    );
  }

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new ProjectContractGenerationError(
      "base URL must use http or https",
    );
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ProjectContractGenerationError(
      "base URL must not contain credentials, query, or fragment",
    );
  }

  if (
    url.pathname !== "/" &&
    url.pathname !== ""
  ) {
    throw new ProjectContractGenerationError(
      "base URL must not contain a path",
    );
  }

  return new URL(url.origin);
}

function normalizeProjectId(value) {
  const projectId =
    requiredString(
      value,
      "project ID",
    );

  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(
      projectId,
    )
  ) {
    throw new ProjectContractGenerationError(
      "project ID must be a lowercase slug",
    );
  }

  return projectId;
}

function normalizeOutDir(value) {
  const target =
    path.resolve(
      requiredString(
        value,
        "output directory",
      ),
    );
  const root =
    path.parse(target).root;

  if (
    target === root ||
    target === process.cwd()
  ) {
    throw new ProjectContractGenerationError(
      "output directory must be a dedicated child directory",
    );
  }

  return target;
}

function requiredString(
  value,
  label,
) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new ProjectContractGenerationError(
      `${label} is required`,
    );
  }

  return value.trim();
}

async function requestJson(
  url,
  credential,
  fetchImpl,
  label,
) {
  const response =
    await fetchImpl(
      url,
      {
        method: "GET",
        headers: {
          authorization:
            `Bearer ${credential}`,
          accept:
            "application/json",
        },
      },
    );

  let text;

  try {
    text = await response.text();
  } catch (error) {
    throw new ProjectContractGenerationError(
      `${label} response could not be read: ${errorMessage(
        error,
      )}`,
    );
  }

  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProjectContractGenerationError(
        `${label} returned non-JSON response with HTTP ${response.status}`,
      );
    }
  }

  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    const code =
      typeof body?.error?.code ===
        "string"
        ? ` (${body.error.code})`
        : "";

    throw new ProjectContractGenerationError(
      `${label} failed with HTTP ${response.status}${code}`,
    );
  }

  return body;
}

function normalizeCatalog(
  catalog,
  projectId,
) {
  if (
    !catalog ||
    typeof catalog !== "object" ||
    Array.isArray(catalog) ||
    catalog.apiVersion !== "v1" ||
    catalog.kind !==
      "ContractCatalog" ||
    catalog.projectId !== projectId ||
    !Array.isArray(
      catalog.contracts,
    )
  ) {
    throw new ProjectContractGenerationError(
      "invalid ETLayer v1 contract catalog",
    );
  }

  const coordinates =
    catalog.contracts.map(
      (item) =>
        normalizeCoordinate(item),
    );

  coordinates.sort(
    (left, right) =>
      left.eventName.localeCompare(
        right.eventName,
      ) ||
      left.version - right.version,
  );

  const seen = new Set();

  for (const coordinate of coordinates) {
    const key =
      JSON.stringify([
        coordinate.eventName,
        coordinate.version,
      ]);

    if (seen.has(key)) {
      throw new ProjectContractGenerationError(
        `duplicate contract coordinate: ${coordinate.eventName}@${coordinate.version}`,
      );
    }

    seen.add(key);
  }

  return coordinates;
}

function normalizeCoordinate(item) {
  if (
    !item ||
    typeof item !== "object" ||
    Array.isArray(item)
  ) {
    throw new ProjectContractGenerationError(
      "invalid contract catalog item",
    );
  }

  const eventName =
    requiredString(
      item.eventName,
      "catalog eventName",
    );
  const version =
    Number(item.version);

  if (
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new ProjectContractGenerationError(
      "catalog version must be a positive integer",
    );
  }

  if (
    typeof item.links?.self !==
      "string" ||
    item.links.self.trim() === ""
  ) {
    throw new ProjectContractGenerationError(
      `catalog artifact link is required for ${eventName}@${version}`,
    );
  }

  return {
    eventName,
    version,
    self:
      item.links.self,
  };
}

function validateArtifactUrl(
  coordinate,
  baseUrl,
  projectId,
) {
  let url;

  try {
    url =
      new URL(
        coordinate.self,
      );
  } catch {
    throw new ProjectContractGenerationError(
      `invalid artifact URL for ${coordinate.eventName}@${coordinate.version}`,
    );
  }

  const expectedPath =
    `/api/v1/projects/${encodeURIComponent(
      projectId,
    )}/contracts/${encodeURIComponent(
      coordinate.eventName,
    )}/${coordinate.version}`;

  if (
    url.origin !== baseUrl.origin ||
    url.pathname !== expectedPath ||
    url.search ||
    url.hash
  ) {
    throw new ProjectContractGenerationError(
      `untrusted artifact URL for ${coordinate.eventName}@${coordinate.version}`,
    );
  }

  return url;
}

function validateArtifact(
  artifact,
  projectId,
  coordinate,
) {
  if (
    !artifact ||
    typeof artifact !== "object" ||
    Array.isArray(artifact) ||
    artifact.apiVersion !== "v1" ||
    artifact.kind !== "Contract" ||
    artifact.projectId !== projectId ||
    artifact.contract?.eventName !==
      coordinate.eventName ||
    Number(
      artifact.contract?.version,
    ) !== coordinate.version
  ) {
    throw new ProjectContractGenerationError(
      `artifact coordinate mismatch for ${coordinate.eventName}@${coordinate.version}`,
    );
  }
}

function filenameFor(
  eventName,
  version,
) {
  const slug =
    eventName
      .toLowerCase()
      .replace(
        /[^a-z0-9]+/g,
        "-",
      )
      .replace(
        /^-+|-+$/g,
        "",
      )
      .slice(0, 48) ||
    "event";
  const digest =
    eventDigest(
      eventName,
    );

  return `${slug}--${digest}--v${version}.ts`;
}

function namespaceFor(
  eventName,
  version,
) {
  return (
    "Contract_" +
    eventDigest(eventName) +
    "_V" +
    version
  );
}

function eventDigest(eventName) {
  return createHash("sha256")
    .update(
      eventName,
      "utf8",
    )
    .digest("hex");
}

function renderIndex(files) {
  return [
    "// Generated by ETLayer. Do not edit.",
    "",
    ...files.map(
      ({ filename, namespace }) =>
        `export * as ${namespace} from ${JSON.stringify(
          "./" +
            filename.replace(
              /\.ts$/,
              ".js",
            ),
        )};`,
    ),
    "",
  ].join("\n");
}

async function publishOutput(
  outDir,
  files,
) {
  const parent =
    path.dirname(outDir);

  await mkdir(
    parent,
    {
      recursive: true,
    },
  );

  let stage =
    await mkdtemp(
      path.join(
        parent,
        ".etlayer-contracts-stage-",
      ),
    );
  let backup = null;
  let targetMoved = false;

  try {
    for (const file of files) {
      await writeFile(
        path.join(
          stage,
          file.filename,
        ),
        file.source,
        "utf8",
      );
    }

    backup =
      outDir +
      ".etlayer-backup-" +
      randomUUID();

    try {
      await rename(
        outDir,
        backup,
      );
      targetMoved = true;
    } catch (error) {
      if (
        error?.code !== "ENOENT"
      ) {
        throw error;
      }
    }

    await rename(
      stage,
      outDir,
    );
    stage = null;

    if (targetMoved) {
      await rm(
        backup,
        {
          recursive: true,
          force: true,
        },
      );
      targetMoved = false;
    }
  } catch (error) {
    if (stage) {
      await rm(
        stage,
        {
          recursive: true,
          force: true,
        },
      ).catch(() => {});
    }

    if (targetMoved) {
      await rename(
        backup,
        outDir,
      ).catch(() => {});
    }

    throw new ProjectContractGenerationError(
      `failed to publish generated contracts: ${errorMessage(
        error,
      )}`,
    );
  }
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

export class ProjectContractGenerationError extends Error {}

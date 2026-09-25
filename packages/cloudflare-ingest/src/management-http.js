import {
  isSupportedDestination,
  profileTemplate,
  projectConfiguration,
  validateProjectId,
} from "./project-config.js";
import { authenticateProjectOperator } from "./operator-auth.js";
import { buildOnboardingBundle } from "./onboarding.js";
import {
  OnboardingConflictError,
  OnboardingNotFoundError,
  OnboardingValidationError,
  ensureOnboarding,
  normalizeOnboardingRequest,
} from "./onboarding-domain.js";
import {
  DestinationCredentialConflictError,
  DestinationCredentialConfigurationError,
  DestinationCredentialDecryptionError,
  DestinationCredentialNotFoundError,
  DestinationCredentialValidationError,
  disableDestinationCredential,
  readDestinationCredentialStatus,
  rewrapDestinationCredential,
  runtimeDefaultDestinationSecret,
  writeDestinationCredential,
} from "./destination-credentials.js";
import {
  RegistryConflictError,
  RegistryNotFoundError,
  RegistryStateError,
  RegistryValidationError,
  createRegistryProducer,
  createRegistryProject,
  credentialFingerprint,
  disableRegistryProducer,
  generateCredential,
  readRegistryProject,
  rotateRegistryProducer,
  setRegistryDestination,
} from "./registry.js";
import {
  EncryptionKeyUsageConfigurationError,
  auditEncryptionKeyUsage,
} from "./encryption-key-usage.js";
import {
  EncryptionRootConfigurationError,
  activeEncryptionRootVersion,
} from "./encryption-roots.js";
import { auditControlPlaneMutation } from "./control-plane-audit.js";
import {
  GovernanceManifestConfigurationError,
  GovernanceManifestValidationError,
  GovernancePlanArchiveError,
  GovernancePlanConfigurationError,
  GovernancePlanValidationError,
  planGovernanceManifest,
} from "./governance-plan.js";
import {
  GovernancePublicationBreakingChangeError,
  GovernancePublicationConfigurationError,
  GovernancePublicationConflictError,
  GovernancePublicationDigestMismatchError,
  GovernancePublicationValidationError,
  publishGovernanceManifest,
  readPublishedContract,
} from "./governance-publication.js";
import {
  ContractLifecycleConfigurationError,
  ContractLifecycleNotFoundError,
  ContractLifecycleTransitionError,
  ContractLifecycleValidationError,
  transitionContractLifecycle,
} from "./contract-lifecycle.js";
import {
  ContractOwnershipConfigurationError,
  ContractOwnershipValidationError,
  readContractOwnership,
  writeContractOwnership,
} from "./contract-ownership.js";

export async function handleManagementRequest(
  request,
  env,
  url = new URL(request.url),
  options = {},
) {
  if (!env.ARCHIVE) {
    return jsonResponse(
      { error: "registry storage is not configured" },
      503,
    );
  }

  if (
    request.method === "POST" &&
    url.pathname === "/_mgmt/projects"
  ) {
    return createProject(request, env, options);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/_mgmt/evidence"
  ) {
    return readManagementEvidence(request, env);
  }

  if (
    request.method === "GET" &&
    url.pathname === "/_mgmt/encryption/key-usage"
  ) {
    return readEncryptionKeyUsage(
      request,
      env,
      options,
    );
  }

  if (
    request.method === "GET" &&
    url.pathname === "/_mgmt/encryption/config"
  ) {
    return readEncryptionConfig(request, env);
  }

  const onboarding = url.pathname.match(
    /^\/_mgmt\/projects\/([^/]+)\/onboarding$/,
  );
  if (request.method === "POST" && onboarding) {
    return provisionOnboarding(
      request,
      env,
      decodeURIComponent(onboarding[1]),
      options,
    );
  }

  const governancePublish = url.pathname.match(
    /^\/_mgmt\/projects\/([^/]+)\/governance\/publish$/,
  );
  if (
    request.method === "POST" &&
    governancePublish
  ) {
    return publishProjectGovernance(
      request,
      env,
      decodeURIComponent(
        governancePublish[1],
      ),
      options,
    );
  }

  const contractOwnership =
    url.pathname.match(
      /^\/_mgmt\/projects\/([^/]+)\/contracts\/([^/]+)\/ownership$/,
    );
  if (contractOwnership) {
    const projectId =
      decodeURIComponent(
        contractOwnership[1],
      );
    const eventName =
      decodeURIComponent(
        contractOwnership[2],
      );

    if (request.method === "PUT") {
      return configureProjectContractOwnership(
        request,
        env,
        projectId,
        eventName,
        options,
      );
    }

    if (request.method === "GET") {
      return getProjectContractOwnership(
        request,
        env,
        projectId,
        eventName,
        options,
      );
    }
  }

  const contractLifecycleAction =
    url.pathname.match(
      /^\/_mgmt\/projects\/([^/]+)\/contracts\/([^/]+)\/(\d+)\/(deprecate|retire)$/,
    );
  if (
    request.method === "POST" &&
    contractLifecycleAction
  ) {
    return changeProjectContractLifecycle(
      request,
      env,
      decodeURIComponent(
        contractLifecycleAction[1],
      ),
      decodeURIComponent(
        contractLifecycleAction[2],
      ),
      Number(
        contractLifecycleAction[3],
      ),
      contractLifecycleAction[4],
      options,
    );
  }

  const producerCreate = url.pathname.match(
    /^\/_mgmt\/projects\/([^/]+)\/producers$/,
  );
  if (request.method === "POST" && producerCreate) {
    return createProducer(
      request,
      env,
      decodeURIComponent(producerCreate[1]),
      options,
    );
  }

  const producerAction = url.pathname.match(
    /^\/_mgmt\/projects\/([^/]+)\/producers\/([^/]+)\/(rotate|disable)$/,
  );
  if (request.method === "POST" && producerAction) {
    const projectId = decodeURIComponent(producerAction[1]);
    const producerId = decodeURIComponent(producerAction[2]);
    const action = producerAction[3];

    if (action === "rotate") {
      return rotateProducer(
        request,
        env,
        projectId,
        producerId,
        options,
      );
    }

    return disableProducer(
      request,
      env,
      projectId,
      producerId,
      options,
    );
  }

  const destinationCredential = url.pathname.match(
    /^\/_mgmt\/projects\/([^/]+)\/destinations\/([^/]+)\/credential$/,
  );
  if (destinationCredential) {
    const projectId = decodeURIComponent(
      destinationCredential[1],
    );
    const destination = decodeURIComponent(
      destinationCredential[2],
    );

    if (request.method === "PUT") {
      return configureDestinationCredential(
        request,
        env,
        projectId,
        destination,
        options,
      );
    }

    if (request.method === "GET") {
      return getDestinationCredential(
        request,
        env,
        projectId,
        destination,
        options,
      );
    }
  }

  const destinationCredentialRewrap =
    url.pathname.match(
      /^\/_mgmt\/projects\/([^/]+)\/destinations\/([^/]+)\/credential\/rewrap$/,
    );
  if (
    request.method === "POST" &&
    destinationCredentialRewrap
  ) {
    return rewrapProjectDestinationCredential(
      request,
      env,
      decodeURIComponent(
        destinationCredentialRewrap[1],
      ),
      decodeURIComponent(
        destinationCredentialRewrap[2],
      ),
      options,
    );
  }

  const destinationCredentialAction = url.pathname.match(
    /^\/_mgmt\/projects\/([^/]+)\/destinations\/([^/]+)\/credential\/(disable|bootstrap-runtime-default)$/,
  );
  if (
    request.method === "POST" &&
    destinationCredentialAction
  ) {
    const projectId = decodeURIComponent(
      destinationCredentialAction[1],
    );
    const destination = decodeURIComponent(
      destinationCredentialAction[2],
    );
    const action = destinationCredentialAction[3];

    if (action === "disable") {
      return disableProjectDestinationCredential(
        request,
        env,
        projectId,
        destination,
        options,
      );
    }

    return bootstrapRuntimeDestinationCredential(
      request,
      env,
      projectId,
      destination,
      options,
    );
  }

  const destination = url.pathname.match(
    /^\/_mgmt\/projects\/([^/]+)\/destinations\/([^/]+)$/,
  );
  if (request.method === "PUT" && destination) {
    return configureDestination(
      request,
      env,
      decodeURIComponent(destination[1]),
      decodeURIComponent(destination[2]),
      options,
    );
  }

  return jsonResponse(
    { error: "management route not found" },
    404,
  );
}

async function readManagementEvidence(request, env) {
  const management = authenticateManagement(
    request,
    env,
  );

  if (!management.ok) {
    return management.reason === "not_configured"
      ? jsonResponse(
          { error: "management credential is not configured" },
          503,
        )
      : jsonResponse(
          { error: "invalid management credential" },
          401,
        );
  }

  const input = await readJsonBody(request);
  if (input.response) return input.response;

  const key = input.value?.key;
  if (
    typeof key !== "string" ||
    !key.startsWith("registry/") ||
    key.includes("..")
  ) {
    return jsonResponse(
      { error: "key must reference exact registry evidence" },
      400,
    );
  }

  const object = await env.ARCHIVE.get(key);
  if (!object) {
    return jsonResponse(
      { error: "registry evidence not found", key },
      404,
    );
  }

  const text =
    typeof object.text === "function"
      ? await object.text()
      : object.body != null
        ? await new Response(object.body).text()
        : null;

  if (text == null) {
    return jsonResponse(
      { error: "registry evidence has no readable body", key },
      500,
    );
  }

  return new Response(text, {
    status: 200,
    headers: {
      "content-type":
        "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function createProject(request, env, options) {
  const management = authenticateManagement(
    request,
    env,
  );

  if (!management.ok) {
    return management.reason === "not_configured"
      ? jsonResponse(
          { error: "management credential is not configured" },
          503,
        )
      : jsonResponse(
          { error: "invalid management credential" },
          401,
        );
  }

  const input = await readJsonBody(request);
  if (input.response) return input.response;

  let projectId;
  try {
    projectId = validateProjectId(input.value?.id);
  } catch (error) {
    return jsonResponse(
      { error: error.message },
      400,
    );
  }

  if (projectConfiguration(projectId)) {
    return jsonResponse(
      { error: "project already exists" },
      409,
    );
  }

  if (
    await readRegistryProject(
      env.ARCHIVE,
      projectId,
    )
  ) {
    return jsonResponse(
      { error: "project already exists" },
      409,
    );
  }

  const cryptoImpl =
    options.crypto || globalThis.crypto;
  const operatorCredential = generateCredential(
    "etl_op",
    cryptoImpl,
  );
  const operatorFingerprint =
    await credentialFingerprint(
      operatorCredential,
      cryptoImpl,
    );

  try {
    const audited = await runAuditedMutation(
      request,
      env,
      options,
      {
        actor: managementActor(),
        action: "project.create",
        target: {
          kind: "project",
          projectId,
        },
        change: {
          status: "active",
        },
      },
      () =>
        createRegistryProject(
          env.ARCHIVE,
          {
            projectId,
            operatorFingerprint,
            now: options.now || new Date(),
          },
        ),
    );

    return jsonResponse(
      {
        project: publicProject(audited.value.project),
        operatorCredential,
      },
      201,
      operationHeaders(audited.operationId),
    );
  } catch (error) {
    return registryErrorResponse(error);
  }
}

async function publishProjectGovernance(
  request,
  env,
  projectId,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  const input = await readJsonBody(request);
  if (input.response) return input.response;

  const manifest = input.value?.manifest;

  if (
    !manifest ||
    manifest.projectId !== projectId
  ) {
    return jsonResponse(
      {
        error:
          "manifest projectId must match the requested project",
      },
      400,
    );
  }

  let plan;

  try {
    const planGovernance =
      options.planGovernanceManifest ||
      planGovernanceManifest;

    plan = await planGovernance(
      env,
      manifest,
      options,
    );
  } catch (error) {
    return governancePublicationErrorResponse(
      error,
    );
  }

  try {
    const audited =
      await runAuditedMutation(
        request,
        env,
        options,
        {
          actor: operatorActor(
            projectId,
            auth.authentication,
          ),
          action:
            "governance.publish",
          target: {
            kind:
              "governance_manifest",
            projectId,
            manifestDigest:
              input.value?.manifestDigest ||
              null,
          },
          change: {
            compatible:
              plan.compatible,
            selected:
              plan.selected,
            changed:
              plan.changed,
            acknowledgeBreaking:
              input.value
                ?.acknowledgeBreaking ===
              true,
          },
        },
        () =>
          publishGovernanceManifest(
            env.ARCHIVE,
            {
              manifest,
              manifestDigest:
                input.value
                  ?.manifestDigest,
              acknowledgeBreaking:
                input.value
                  ?.acknowledgeBreaking,
              plan,
            },
            {
              now:
                options.now ||
                new Date(),
              crypto:
                options.crypto ||
                globalThis.crypto,
            },
          ),
      );

    const publication =
      audited.value.publication;

    return jsonResponse(
      {
        created:
          audited.value.created,
        publication: {
          version:
            publication.version,
          projectId:
            publication.projectId,
          manifestDigest:
            publication.manifestDigest,
          publishedAt:
            publication.publishedAt,
          compatible:
            publication.compatible,
          selected:
            publication.selected,
          changed:
            publication.changed,
          contracts:
            publication.manifest
              .contracts.map(
                (change) => ({
                  eventName:
                    change.eventName,
                  version:
                    change
                      .proposedContract
                      .version,
                  contractId:
                    change
                      .proposedContract
                      .id,
                }),
              ),
        },
      },
      audited.value.created
        ? 201
        : 200,
      operationHeaders(
        audited.operationId,
      ),
    );
  } catch (error) {
    return governancePublicationErrorResponse(
      error,
    );
  }
}

async function configureProjectContractOwnership(
  request,
  env,
  projectId,
  eventName,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  const input = await readJsonBody(request);
  if (input.response) return input.response;

  const contactKinds = Array.isArray(
    input.value?.contacts,
  )
    ? [
        ...new Set(
          input.value.contacts
            .map((contact) =>
              contact?.kind,
            )
            .filter(
              (kind) =>
                typeof kind === "string",
            ),
        ),
      ].sort()
    : [];

  try {
    const audited =
      await runAuditedMutation(
        request,
        env,
        options,
        {
          actor: operatorActor(
            projectId,
            auth.authentication,
          ),
          action:
            "contract.ownership.configure",
          target: {
            kind:
              "contract_ownership",
            projectId,
            eventName,
          },
          change: {
            team:
              input.value?.team ||
              null,
            domain:
              input.value?.domain ||
              null,
            contactCount:
              Array.isArray(
                input.value?.contacts,
              )
                ? input.value.contacts
                    .length
                : 0,
            contactKinds,
          },
        },
        () =>
          writeContractOwnership(
            env.ARCHIVE,
            {
              projectId,
              eventName,
              team:
                input.value?.team,
              domain:
                input.value?.domain,
              contacts:
                input.value?.contacts,
            },
            {
              now:
                options.now ||
                new Date(),
            },
          ),
      );

    return jsonResponse(
      {
        changed:
          audited.value.changed,
        ownership:
          audited.value.state,
      },
      200,
      operationHeaders(
        audited.operationId,
      ),
    );
  } catch (error) {
    return contractOwnershipErrorResponse(
      error,
    );
  }
}

async function getProjectContractOwnership(
  request,
  env,
  projectId,
  eventName,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  try {
    const ownership =
      await readContractOwnership(
        env.ARCHIVE,
        projectId,
        eventName,
      );

    if (!ownership) {
      return jsonResponse(
        {
          error:
            "contract ownership was not found",
        },
        404,
      );
    }

    return jsonResponse(
      { ownership },
      200,
    );
  } catch (error) {
    return contractOwnershipErrorResponse(
      error,
    );
  }
}

async function changeProjectContractLifecycle(
  request,
  env,
  projectId,
  eventName,
  contractVersion,
  action,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  const body = await readJsonBody(request);
  if (body.response) return body.response;

  let published;

  try {
    published =
      await readPublishedContract(
        env.ARCHIVE,
        projectId,
        eventName,
        contractVersion,
      );
  } catch (error) {
    return contractLifecycleErrorResponse(
      error,
    );
  }

  if (!published) {
    return jsonResponse(
      {
        error:
          "published contract was not found",
      },
      404,
    );
  }

  const toStatus =
    action === "deprecate"
      ? "deprecated"
      : "retired";

  try {
    const audited =
      await runAuditedMutation(
        request,
        env,
        options,
        {
          actor: operatorActor(
            projectId,
            auth.authentication,
          ),
          action:
            "contract." + action,
          target: {
            kind: "contract",
            projectId,
            eventName,
            contractVersion,
            contractId:
              published.contract.id,
          },
          change: {
            from:
              published.contractStatus,
            to: toStatus,
          },
        },
        () =>
          transitionContractLifecycle(
            env.ARCHIVE,
            {
              projectId,
              eventName,
              contractVersion,
              contractId:
                published.contract.id,
              manifestDigest:
                published.manifestDigest,
              publishedAt:
                published.publishedAt,
              toStatus,
            },
            {
              now:
                options.now ||
                new Date(),
            },
          ),
      );

    return jsonResponse(
      {
        changed:
          audited.value.changed,
        contract: {
          projectId,
          eventName,
          version:
            contractVersion,
          contractId:
            published.contract.id,
          status:
            audited.value.state.status,
          publishedAt:
            audited.value.state
              .publishedAt,
          deprecatedAt:
            audited.value.state
              .deprecatedAt,
          retiredAt:
            audited.value.state
              .retiredAt,
          manifestDigest:
            audited.value.state
              .manifestDigest,
        },
      },
      200,
      operationHeaders(
        audited.operationId,
      ),
    );
  } catch (error) {
    return contractLifecycleErrorResponse(
      error,
    );
  }
}

async function provisionOnboarding(
  request,
  env,
  projectId,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  if (projectConfiguration(projectId)) {
    return jsonResponse(
      {
        error:
          "external onboarding requires a dynamic project",
      },
      400,
    );
  }

  const input = await readJsonBody(request);
  if (input.response) return input.response;

  let normalized;
  try {
    normalized = normalizeOnboardingRequest(input.value);
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "invalid onboarding request",
      },
      400,
    );
  }

  const cryptoImpl =
    options.crypto || globalThis.crypto;
  const credential = generateCredential(
    "etl_prod",
    cryptoImpl,
  );

  try {
    const audited = await runAuditedMutation(
      request,
      env,
      options,
      {
        actor: operatorActor(
          projectId,
          auth.authentication,
        ),
        action: "project.onboard",
        target: {
          kind: "project",
          projectId,
        },
        change: {
          producerId: normalized.producerId,
          destinations: normalized.destinations,
        },
      },
      () =>
        ensureOnboarding(
          env.ARCHIVE,
          {
            projectId,
            ...normalized,
            credential,
            now: options.now || new Date(),
            crypto: cryptoImpl,
          },
        ),
    );

    const onboarded = audited.value;
    const bundle = buildOnboardingBundle({
      requestUrl: request.url,
      projectId,
      producer: onboarded.producer,
      credential,
      destinations: onboarded.destinations,
    });

    return jsonResponse(
      bundle,
      201,
      operationHeaders(audited.operationId),
    );
  } catch (error) {
    if (error instanceof OnboardingValidationError) {
      return jsonResponse(
        { error: error.message },
        400,
      );
    }

    if (error instanceof OnboardingNotFoundError) {
      return jsonResponse(
        { error: error.message },
        404,
      );
    }

    if (error instanceof OnboardingConflictError) {
      return jsonResponse(
        { error: error.message },
        409,
      );
    }

    return registryErrorResponse(error);
  }
}

async function createProducer(
  request,
  env,
  projectId,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  const input = await readJsonBody(request);
  if (input.response) return input.response;

  let profile;
  try {
    validateProjectId(projectId);
    validateProducerId(input.value?.id);
    profile = profileTemplate(input.value?.profileId);
  } catch (error) {
    return jsonResponse(
      { error: error.message },
      400,
    );
  }

  const cryptoImpl =
    options.crypto || globalThis.crypto;
  const credential = generateCredential(
    "etl_prod",
    cryptoImpl,
  );
  const fingerprint =
    await credentialFingerprint(
      credential,
      cryptoImpl,
    );

  try {
    const audited = await runAuditedMutation(
      request,
      env,
      options,
      {
        actor: operatorActor(
          projectId,
          auth.authentication,
        ),
        action: "producer.create",
        target: {
          kind: "producer",
          projectId,
          producerId: input.value.id,
        },
        change: {
          profileId: profile.profileId,
          producerKind: profile.producerKind,
        },
      },
      () =>
        createRegistryProducer(
          env.ARCHIVE,
          {
            projectId,
            producerId: input.value.id,
            profile,
            credentialFingerprint: fingerprint,
            now: options.now || new Date(),
          },
        ),
    );

    return jsonResponse(
      {
        producer: publicProducer(audited.value.producer),
        credential,
      },
      201,
      operationHeaders(audited.operationId),
    );
  } catch (error) {
    return registryErrorResponse(error);
  }
}

async function rotateProducer(
  request,
  env,
  projectId,
  producerId,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  try {
    validateProducerId(producerId);
  } catch (error) {
    return jsonResponse(
      { error: error.message },
      400,
    );
  }

  const cryptoImpl =
    options.crypto || globalThis.crypto;
  const credential = generateCredential(
    "etl_prod",
    cryptoImpl,
  );
  const fingerprint =
    await credentialFingerprint(
      credential,
      cryptoImpl,
    );

  try {
    const audited = await runAuditedMutation(
      request,
      env,
      options,
      {
        actor: operatorActor(
          projectId,
          auth.authentication,
        ),
        action: "producer.rotate",
        target: {
          kind: "producer",
          projectId,
          producerId,
        },
        change: {
          kind: "credential_rotation",
        },
      },
      () =>
        rotateRegistryProducer(
          env.ARCHIVE,
          {
            projectId,
            producerId,
            credentialFingerprint: fingerprint,
            now: options.now || new Date(),
          },
        ),
    );

    return jsonResponse(
      {
        producer: publicProducer(audited.value.producer),
        credential,
      },
      200,
      operationHeaders(audited.operationId),
    );
  } catch (error) {
    return registryErrorResponse(error);
  }
}

async function disableProducer(
  request,
  env,
  projectId,
  producerId,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  try {
    validateProducerId(producerId);
    const audited = await runAuditedMutation(
      request,
      env,
      options,
      {
        actor: operatorActor(
          projectId,
          auth.authentication,
        ),
        action: "producer.disable",
        target: {
          kind: "producer",
          projectId,
          producerId,
        },
        change: {
          status: "disabled",
        },
      },
      () =>
        disableRegistryProducer(
          env.ARCHIVE,
          {
            projectId,
            producerId,
            now: options.now || new Date(),
          },
        ),
    );

    return jsonResponse(
      { producer: publicProducer(audited.value) },
      200,
      operationHeaders(audited.operationId),
    );
  } catch (error) {
    return registryErrorResponse(error);
  }
}

async function readEncryptionConfig(
  request,
  env,
) {
  const management = authenticateManagement(
    request,
    env,
  );

  if (!management.ok) {
    return management.reason === "not_configured"
      ? jsonResponse(
          {
            error:
              "management credential is not configured",
          },
          503,
        )
      : jsonResponse(
          { error: "invalid management credential" },
          401,
        );
  }

  try {
    return jsonResponse(
      {
        destination: {
          activeKeyVersion:
            activeEncryptionRootVersion(
              env,
              "destination",
            ),
        },
        idempotency: {
          activeKeyVersion:
            activeEncryptionRootVersion(
              env,
              "idempotency",
            ),
        },
      },
      200,
    );
  } catch (error) {
    if (
      error instanceof
        EncryptionRootConfigurationError
    ) {
      return jsonResponse(
        { error: error.message },
        503,
      );
    }

    throw error;
  }
}

async function readEncryptionKeyUsage(
  request,
  env,
  options,
) {
  const management = authenticateManagement(
    request,
    env,
  );

  if (!management.ok) {
    return management.reason === "not_configured"
      ? jsonResponse(
          {
            error:
              "management credential is not configured",
          },
          503,
        )
      : jsonResponse(
          { error: "invalid management credential" },
          401,
        );
  }

  try {
    return jsonResponse(
      {
        usage: await auditEncryptionKeyUsage(
          env.ARCHIVE,
          {
            now: options.now || new Date(),
          },
        ),
      },
      200,
    );
  } catch (error) {
    if (
      error instanceof
        EncryptionKeyUsageConfigurationError
    ) {
      return jsonResponse(
        { error: error.message },
        503,
      );
    }

    throw error;
  }
}

async function rewrapProjectDestinationCredential(
  request,
  env,
  projectId,
  destination,
  options,
) {
  const management = authenticateManagement(
    request,
    env,
  );

  if (!management.ok) {
    return management.reason === "not_configured"
      ? jsonResponse(
          {
            error:
              "management credential is not configured",
          },
          503,
        )
      : jsonResponse(
          { error: "invalid management credential" },
          401,
        );
  }

  try {
    validateProjectId(projectId);
  } catch (error) {
    return jsonResponse(
      { error: error.message },
      400,
    );
  }

  const dynamicError = dynamicProjectOnly(projectId);
  if (dynamicError) return dynamicError;

  if (!isSupportedDestination(destination)) {
    return jsonResponse(
      {
        error:
          `unsupported destination: ${destination}`,
      },
      400,
    );
  }

  const input = await readJsonBody(request);
  if (input.response) return input.response;

  if (
    typeof input.value?.targetKeyVersion !==
      "string"
  ) {
    return jsonResponse(
      {
        error:
          "targetKeyVersion must be a string",
      },
      400,
    );
  }

  try {
    const audited = await runAuditedMutation(
      request,
      env,
      options,
      {
        actor: managementActor(),
        action: "destination_credential.rewrap",
        target: {
          kind: "destination_credential",
          projectId,
          destination,
        },
        change: {
          targetKeyVersion:
            input.value.targetKeyVersion,
        },
      },
      () =>
        rewrapDestinationCredential(
          env.ARCHIVE,
          env,
          {
            projectId,
            destination,
            targetKeyVersion:
              input.value.targetKeyVersion,
            now: options.now || new Date(),
            crypto:
              options.crypto || globalThis.crypto,
          },
        ),
    );

    const result = audited.value;

    return jsonResponse(
      {
        rewrapped: result.rewrapped,
        previous: {
          credentialId:
            result.previousPointer.credentialId,
          keyVersion:
            result.previousPointer.keyVersion,
        },
        credential:
          await readDestinationCredentialStatus(
            env.ARCHIVE,
            projectId,
            destination,
          ),
      },
      200,
      operationHeaders(audited.operationId),
    );
  } catch (error) {
    return destinationCredentialErrorResponse(error);
  }
}

async function configureDestinationCredential(
  request,
  env,
  projectId,
  destination,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  const dynamicError = dynamicProjectOnly(projectId);
  if (dynamicError) return dynamicError;

  if (!isSupportedDestination(destination)) {
    return jsonResponse(
      {
        error:
          `unsupported destination: ${destination}`,
      },
      400,
    );
  }

  const input = await readJsonBody(request);
  if (input.response) return input.response;

  if (
    typeof input.value?.secret !== "string" ||
    input.value.secret.length === 0
  ) {
    return jsonResponse(
      { error: "secret must be a non-empty string" },
      400,
    );
  }

  try {
    const audited = await runAuditedMutation(
      request,
      env,
      options,
      {
        actor: operatorActor(
          projectId,
          auth.authentication,
        ),
        action: "destination_credential.configure",
        target: {
          kind: "destination_credential",
          projectId,
          destination,
        },
        change: {
          state: "configured",
        },
      },
      () =>
        writeDestinationCredential(
          env.ARCHIVE,
          env,
          {
            projectId,
            destination,
            secret: input.value.secret,
            now: options.now || new Date(),
            crypto:
              options.crypto || globalThis.crypto,
          },
        ),
    );

    return jsonResponse(
      {
        credential:
          await readDestinationCredentialStatus(
            env.ARCHIVE,
            projectId,
            destination,
          ),
      },
      200,
      operationHeaders(audited.operationId),
    );
  } catch (error) {
    return destinationCredentialErrorResponse(error);
  }
}

async function getDestinationCredential(
  request,
  env,
  projectId,
  destination,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  const dynamicError = dynamicProjectOnly(projectId);
  if (dynamicError) return dynamicError;

  if (!isSupportedDestination(destination)) {
    return jsonResponse(
      {
        error:
          `unsupported destination: ${destination}`,
      },
      400,
    );
  }

  try {
    return jsonResponse(
      {
        credential:
          await readDestinationCredentialStatus(
            env.ARCHIVE,
            projectId,
            destination,
          ),
      },
      200,
    );
  } catch (error) {
    return destinationCredentialErrorResponse(error);
  }
}

async function disableProjectDestinationCredential(
  request,
  env,
  projectId,
  destination,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  const dynamicError = dynamicProjectOnly(projectId);
  if (dynamicError) return dynamicError;

  try {
    const audited = await runAuditedMutation(
      request,
      env,
      options,
      {
        actor: operatorActor(
          projectId,
          auth.authentication,
        ),
        action: "destination_credential.disable",
        target: {
          kind: "destination_credential",
          projectId,
          destination,
        },
        change: {
          status: "disabled",
        },
      },
      () =>
        disableDestinationCredential(
          env.ARCHIVE,
          {
            projectId,
            destination,
            now: options.now || new Date(),
          },
        ),
    );

    return jsonResponse(
      {
        credential:
          await readDestinationCredentialStatus(
            env.ARCHIVE,
            projectId,
            destination,
          ),
      },
      200,
      operationHeaders(audited.operationId),
    );
  } catch (error) {
    return destinationCredentialErrorResponse(error);
  }
}

async function bootstrapRuntimeDestinationCredential(
  request,
  env,
  projectId,
  destination,
  options,
) {
  const management = authenticateManagement(
    request,
    env,
  );

  if (!management.ok) {
    return management.reason === "not_configured"
      ? jsonResponse(
          {
            error:
              "management credential is not configured",
          },
          503,
        )
      : jsonResponse(
          { error: "invalid management credential" },
          401,
        );
  }

  try {
    validateProjectId(projectId);
  } catch (error) {
    return jsonResponse(
      { error: error.message },
      400,
    );
  }

  const dynamicError = dynamicProjectOnly(projectId);
  if (dynamicError) return dynamicError;

  const project = await readRegistryProject(
    env.ARCHIVE,
    projectId,
  );
  if (!project) {
    return jsonResponse(
      { error: "unknown project" },
      404,
    );
  }

  let runtime;
  try {
    runtime = runtimeDefaultDestinationSecret(
      env,
      destination,
    );
  } catch (error) {
    return destinationCredentialErrorResponse(error);
  }

  if (!runtime.secret) {
    return jsonResponse(
      {
        error:
          `${runtime.envName || "runtime destination secret"} is not configured`,
      },
      503,
    );
  }

  try {
    const audited = await runAuditedMutation(
      request,
      env,
      options,
      {
        actor: managementActor(),
        action:
          "destination_credential.bootstrap_runtime_default",
        target: {
          kind: "destination_credential",
          projectId,
          destination,
        },
        change: {
          source: "runtime_default",
        },
      },
      () =>
        writeDestinationCredential(
          env.ARCHIVE,
          env,
          {
            projectId,
            destination,
            secret: runtime.secret,
            now: options.now || new Date(),
            crypto:
              options.crypto || globalThis.crypto,
          },
        ),
    );

    return jsonResponse(
      {
        source: "runtime_default",
        credential:
          await readDestinationCredentialStatus(
            env.ARCHIVE,
            projectId,
            destination,
          ),
      },
      200,
      operationHeaders(audited.operationId),
    );
  } catch (error) {
    return destinationCredentialErrorResponse(error);
  }
}

async function configureDestination(
  request,
  env,
  projectId,
  destination,
  options,
) {
  const auth = await projectAuth(
    request,
    env,
    projectId,
    options,
  );
  if (auth.response) return auth.response;

  if (!isSupportedDestination(destination)) {
    return jsonResponse(
      {
        error:
          `unsupported destination: ${destination}`,
      },
      400,
    );
  }

  const input = await readJsonBody(request);
  if (input.response) return input.response;

  if (typeof input.value?.enabled !== "boolean") {
    return jsonResponse(
      { error: "enabled must be boolean" },
      400,
    );
  }

  try {
    const audited = await runAuditedMutation(
      request,
      env,
      options,
      {
        actor: operatorActor(
          projectId,
          auth.authentication,
        ),
        action: "destination.configure",
        target: {
          kind: "destination",
          projectId,
          destination,
        },
        change: {
          enabled: input.value.enabled,
        },
      },
      () =>
        setRegistryDestination(
          env.ARCHIVE,
          {
            projectId,
            destination,
            enabled: input.value.enabled,
            now: options.now || new Date(),
          },
        ),
    );

    return jsonResponse(
      {
        project: publicProject(audited.value),
        destination,
        enabled: input.value.enabled,
      },
      200,
      operationHeaders(audited.operationId),
    );
  } catch (error) {
    return registryErrorResponse(error);
  }
}

async function projectAuth(
  request,
  env,
  projectId,
  options,
) {
  try {
    validateProjectId(projectId);
  } catch (error) {
    return {
      response: jsonResponse(
        { error: error.message },
        400,
      ),
    };
  }

  const authenticate =
    options.authenticateProjectOperator ||
    authenticateProjectOperator;
  const authentication = await authenticate(
    request,
    env,
    projectId,
    { crypto: options.crypto },
  );

  if (authentication.ok) {
    return { authentication };
  }

  if (
    authentication.reason ===
    "operator_credential_not_configured"
  ) {
    return {
      response: jsonResponse(
        {
          error:
            "operator credential is not configured for project",
        },
        503,
      ),
    };
  }

  if (authentication.reason === "unknown_project") {
    return {
      response: jsonResponse(
        { error: "unknown project" },
        404,
      ),
    };
  }

  return {
    response: jsonResponse(
      {
        error:
          "invalid operator credential for project",
      },
      401,
    ),
  };
}

async function runAuditedMutation(
  request,
  env,
  options,
  descriptor,
  mutate,
) {
  const audit =
    options.auditControlPlaneMutation ||
    auditControlPlaneMutation;

  return audit(
    env.ARCHIVE,
    {
      ...descriptor,
      request: {
        method: request.method,
        path: new URL(request.url).pathname,
      },
    },
    mutate,
    {
      now: options.now,
      crypto: options.crypto || globalThis.crypto,
      operationId: options.operationId,
    },
  );
}

function managementActor() {
  return {
    kind: "management",
    scope: "global",
  };
}

function operatorActor(projectId, authentication) {
  return {
    kind: "project_operator",
    projectId,
    source: authentication?.source || "unknown",
  };
}

function operationHeaders(operationId) {
  return {
    "x-etlayer-operation-id": operationId,
  };
}

function authenticateManagement(request, env) {
  if (!env.ETLAYER_MANAGEMENT_KEY) {
    return {
      ok: false,
      reason: "not_configured",
    };
  }

  const authorization =
    request.headers.get("authorization");

  if (
    authorization !==
    `Bearer ${env.ETLAYER_MANAGEMENT_KEY}`
  ) {
    return {
      ok: false,
      reason: "invalid",
    };
  }

  return { ok: true };
}

async function readJsonBody(request) {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return {
      response: jsonResponse(
        { error: "content-type must be application/json" },
        415,
      ),
    };
  }

  try {
    return { value: await request.json() };
  } catch {
    return {
      response: jsonResponse(
        { error: "request body is not valid JSON" },
        400,
      ),
    };
  }
}

function publicProject(project) {
  return {
    version: project.version,
    id: project.id,
    status: project.status,
    destinations: [...(project.destinations || [])],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function publicProducer(producer) {
  return {
    version: producer.version,
    id: producer.id,
    projectId: producer.projectId,
    status: producer.status,
    profileId: producer.profileId,
    producerKind: producer.producerKind,
    allowedAuthorityKinds: [
      ...(producer.allowedAuthorityKinds || []),
    ],
    createdAt: producer.createdAt,
    updatedAt: producer.updatedAt,
    disabledAt: producer.disabledAt || null,
  };
}

function validateProducerId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value)
  ) {
    throw new RegistryValidationError(
      "producer id must be a lowercase slug",
    );
  }

  return value;
}

function dynamicProjectOnly(projectId) {
  if (projectConfiguration(projectId)) {
    return jsonResponse(
      {
        error:
          "project-scoped destination credentials require a dynamic project",
      },
      400,
    );
  }

  return null;
}

function contractOwnershipErrorResponse(
  error,
) {
  if (
    error instanceof
      ContractOwnershipValidationError
  ) {
    return jsonResponse(
      { error: error.message },
      400,
    );
  }

  if (
    error instanceof
      ContractOwnershipConfigurationError
  ) {
    return jsonResponse(
      { error: error.message },
      503,
    );
  }

  throw error;
}

function contractLifecycleErrorResponse(
  error,
) {
  if (
    error instanceof
      ContractLifecycleValidationError ||
    error instanceof
      GovernancePublicationValidationError
  ) {
    return jsonResponse(
      { error: error.message },
      400,
    );
  }

  if (
    error instanceof
      ContractLifecycleNotFoundError
  ) {
    return jsonResponse(
      { error: error.message },
      404,
    );
  }

  if (
    error instanceof
      ContractLifecycleTransitionError
  ) {
    return jsonResponse(
      { error: error.message },
      409,
    );
  }

  if (
    error instanceof
      ContractLifecycleConfigurationError ||
    error instanceof
      GovernancePublicationConfigurationError
  ) {
    return jsonResponse(
      { error: error.message },
      503,
    );
  }

  throw error;
}

function governancePublicationErrorResponse(
  error,
) {
  if (
    error instanceof
      GovernanceManifestValidationError ||
    error instanceof
      GovernancePlanValidationError ||
    error instanceof
      GovernancePublicationValidationError
  ) {
    return jsonResponse(
      { error: error.message },
      400,
    );
  }

  if (
    error instanceof
      GovernancePublicationDigestMismatchError ||
    error instanceof
      GovernancePublicationBreakingChangeError ||
    error instanceof
      GovernancePublicationConflictError
  ) {
    return jsonResponse(
      { error: error.message },
      409,
    );
  }

  if (
    error instanceof
      GovernanceManifestConfigurationError ||
    error instanceof
      GovernancePlanConfigurationError ||
    error instanceof
      GovernancePublicationConfigurationError
  ) {
    return jsonResponse(
      { error: error.message },
      503,
    );
  }

  if (
    error instanceof
      GovernancePlanArchiveError
  ) {
    return jsonResponse(
      { error: error.message },
      500,
    );
  }

  throw error;
}

function destinationCredentialErrorResponse(error) {
  if (
    error instanceof
      DestinationCredentialValidationError
  ) {
    return jsonResponse(
      { error: error.message },
      400,
    );
  }

  if (
    error instanceof
      DestinationCredentialConflictError
  ) {
    return jsonResponse(
      { error: error.message },
      409,
    );
  }

  if (
    error instanceof
      DestinationCredentialNotFoundError
  ) {
    return jsonResponse(
      { error: error.message },
      404,
    );
  }

  if (
    error instanceof
      DestinationCredentialConfigurationError
  ) {
    return jsonResponse(
      { error: error.message },
      503,
    );
  }

  if (
    error instanceof
      DestinationCredentialDecryptionError
  ) {
    return jsonResponse(
      { error: "destination credential is unreadable" },
      500,
    );
  }

  throw error;
}

function registryErrorResponse(error) {
  if (error instanceof RegistryConflictError) {
    return jsonResponse(
      { error: error.message },
      409,
    );
  }

  if (error instanceof RegistryNotFoundError) {
    return jsonResponse(
      { error: error.message },
      404,
    );
  }

  if (
    error instanceof RegistryStateError ||
    error instanceof RegistryValidationError
  ) {
    return jsonResponse(
      { error: error.message },
      400,
    );
  }

  throw error;
}

function isJsonContentType(contentType) {
  if (!contentType) return false;
  return (
    contentType.split(";", 1)[0].trim().toLowerCase() ===
    "application/json"
  );
}

function jsonResponse(
  body,
  status,
  extraHeaders = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type":
        "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

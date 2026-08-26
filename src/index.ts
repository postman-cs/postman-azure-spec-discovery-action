// GitHub Action shell -- see runtime.ts for the core execution logic (execute, resolveInputs).
import * as core from '@actions/core';

import { actionSink, createLogger, createTelemetryContext, type Logger } from '@postman-cs/automation-core';

import { contractOutputNames, type DiscoveredService } from './contracts.js';
import { resolveActionVersion } from './action-version.js';
import {
  ApimSdkClient,
  AppServiceSdkClient,
  AppServiceRuntimeSdkClient,
  createAzureCredential,
  CustomApisSdkClient,
  LogicWorkflowsSdkClient,
  LogicAppsNativeSdkClient,
  ResourceGraphSdkClient,
  SubscriptionsSdkClient,
  TemplateSpecsSdkClient,
  EventGridSdkClient,
  ServiceBusSdkClient,
  FunctionsSdkClient,
  SourceControlSdkClient,
  type AzureApimClient,
  type AzureAppServiceClient,
  type AzureAppServiceRuntimeClient,
  type AzureCustomApisClient,
  type AzureLogicAppsNativeClient,
  type AzureLogicWorkflowsClient,
  type AzureResourceGraphClient,
  type AzureSubscriptionsClient,
  type AzureTemplateSpecsClient,
  type AzureEventGridClient,
  type AzureServiceBusClient,
  type AzureFunctionsClient,
  type AzureSourceControlClient
} from './lib/azure/clients.js';
import { ApiCenterSdkClient, type AzureApiCenterClient } from './lib/azure/api-center-client.js';
import { formatUserSafeError } from './lib/logging/sanitize.js';
import { appendAmbiguityStepSummary } from './lib/logging/step-summary.js';
import { prepareTelemetryCredentials, resolveTelemetryTeamId } from './lib/postman/telemetry-credentials.js';
import {
  defaultWriteSpecFile,
  execute,
  getInput,
  readActionInputs,
  type InputReaderLike,
  type ReporterLike
} from './runtime.js';
import type { SpecProvider } from './lib/providers/types.js';

export interface CoreLike extends InputReaderLike, ReporterLike {
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  setSecret?(value: string): void;
}

export interface GitHubActionDependencies {
  subscriptions?: AzureSubscriptionsClient;
  createApimClient?: (subscriptionId: string) => AzureApimClient;
  createAppServiceClient?: (subscriptionId: string) => AzureAppServiceClient;
  createApiCenterClient?: (subscriptionId: string) => AzureApiCenterClient;
  createCustomApisClient?: (subscriptionId: string) => AzureCustomApisClient;
  createLogicWorkflowsClient?: (subscriptionId: string) => AzureLogicWorkflowsClient;
  createLogicAppsNativeClient?: (subscriptionId: string) => AzureLogicAppsNativeClient;
  createAppServiceRuntimeClient?: (subscriptionId: string) => AzureAppServiceRuntimeClient;
  createTemplateSpecsClient?: (subscriptionId: string) => AzureTemplateSpecsClient;
  createEventGridClient?: (subscriptionId: string) => AzureEventGridClient;
  createServiceBusClient?: (subscriptionId: string) => AzureServiceBusClient;
  createFunctionsClient?: (subscriptionId: string) => AzureFunctionsClient;
  createSourceControlClient?: (subscriptionId: string) => AzureSourceControlClient;
  createResourceGraphClient?: () => AzureResourceGraphClient;
  writeSpecFile?: (outputPath: string, content: string, rootPath: string) => Promise<void>;
  providers?: SpecProvider[];
  /** Injected by tests; otherwise built over `actionCore` when the run starts. */
  logger?: Logger;
}

export async function runAction(
  actionCore: CoreLike = core,
  dependencies: GitHubActionDependencies = {}
): Promise<DiscoveredService[]> {
  const actionVersion = resolveActionVersion();
  const logger =
    dependencies.logger ??
    createLogger({
      sink: actionSink(actionCore),
      fields: { action: 'azure-spec-discovery', action_version: actionVersion }
    });
  const telemetry = createTelemetryContext({
    action: 'azure-spec-discovery',
    actionVersion,
    logger: actionCore
  });
  telemetry.setTeamId(resolveTelemetryTeamId(process.env));
  const postmanApiKey = getInput('postman-api-key');
  const postmanAccessToken = getInput('postman-access-token');
  // Register before any phase can run: a credential that reaches the logger
  // after the first line is a credential that already leaked once.
  logger.addSecret(postmanApiKey);
  logger.addSecret(postmanAccessToken);
  if (postmanApiKey) {
    actionCore.setSecret?.(postmanApiKey);
  }
  if (postmanAccessToken) {
    actionCore.setSecret?.(postmanAccessToken);
  }
  const { accountType } = await logger.phase('prepare-telemetry-credentials', async () =>
    prepareTelemetryCredentials({
      postmanApiKey,
      postmanAccessToken,
      onToken: (token) => {
        logger.addSecret(token);
        actionCore.setSecret?.(token);
      },
      onWarning: (message) => actionCore.warning(message)
    })
  );
  try {
    const result = await logger.phase('discover', async () =>
      runActionInner(actionCore, dependencies, logger)
    );
    telemetry.setAccountType(accountType);
    telemetry.emitCompletion('success');
    return result;
  } catch (error) {
    telemetry.setAccountType(accountType);
    telemetry.emitCompletion('failure');
    throw error;
  }
}

async function runActionInner(
  actionCore: CoreLike = core,
  dependencies: GitHubActionDependencies = {},
  logger?: Logger
): Promise<DiscoveredService[]> {
  const inputs = readActionInputs(actionCore);
  logger?.debug('resolved inputs', {
    mode: inputs.mode,
    dry_run: inputs.dryRun,
    max_attempts: inputs.maxAttempts,
    request_timeout_ms: inputs.requestTimeoutMs
  });
  const useProductionProviders = !dependencies.providers;
  const credential = !dependencies.subscriptions || useProductionProviders ? createAzureCredential() : undefined;
  const sdkOptions = { requestTimeoutMs: inputs.requestTimeoutMs, maxAttempts: inputs.maxAttempts };

  const result = await execute(inputs, {
    core: actionCore,
    subscriptions: dependencies.subscriptions ?? new SubscriptionsSdkClient(credential!, sdkOptions),
    createApimClient:
      dependencies.createApimClient ?? ((subscriptionId) => new ApimSdkClient(credential!, subscriptionId, sdkOptions)),
    createAppServiceClient:
      dependencies.createAppServiceClient ??
      ((subscriptionId) => new AppServiceSdkClient(credential!, subscriptionId, sdkOptions)),
    createApiCenterClient:
      dependencies.createApiCenterClient ??
      (useProductionProviders ? (subscriptionId) => new ApiCenterSdkClient(credential!, subscriptionId, sdkOptions) : undefined),
    createCustomApisClient:
      dependencies.createCustomApisClient ??
      (useProductionProviders ? (subscriptionId) => new CustomApisSdkClient(credential!, subscriptionId, sdkOptions) : undefined),
    createLogicWorkflowsClient:
      dependencies.createLogicWorkflowsClient ??
      (useProductionProviders ? (subscriptionId) => new LogicWorkflowsSdkClient(credential!, subscriptionId, sdkOptions) : undefined),
    createLogicAppsNativeClient:
      dependencies.createLogicAppsNativeClient ??
      (useProductionProviders ? (subscriptionId) => new LogicAppsNativeSdkClient(credential!, subscriptionId, sdkOptions) : undefined),
    createAppServiceRuntimeClient:
      dependencies.createAppServiceRuntimeClient ??
      (useProductionProviders ? (subscriptionId) => new AppServiceRuntimeSdkClient(credential!, subscriptionId, sdkOptions) : undefined),
    createTemplateSpecsClient:
      dependencies.createTemplateSpecsClient ??
      (useProductionProviders ? (subscriptionId) => new TemplateSpecsSdkClient(credential!, subscriptionId, sdkOptions) : undefined),
    createEventGridClient:
      dependencies.createEventGridClient ??
      (useProductionProviders ? (subscriptionId) => new EventGridSdkClient(credential!, subscriptionId, sdkOptions) : undefined),
    createServiceBusClient:
      dependencies.createServiceBusClient ??
      (useProductionProviders ? (subscriptionId) => new ServiceBusSdkClient(credential!, subscriptionId, sdkOptions) : undefined),
    createFunctionsClient:
      dependencies.createFunctionsClient ??
      (useProductionProviders ? (subscriptionId) => new FunctionsSdkClient(credential!, subscriptionId, sdkOptions) : undefined),
    createSourceControlClient:
      dependencies.createSourceControlClient ??
      (useProductionProviders
        ? (subscriptionId) => new SourceControlSdkClient(credential!, subscriptionId, sdkOptions)
        : undefined),
    createResourceGraphClient:
      dependencies.createResourceGraphClient ??
      (useProductionProviders ? () => new ResourceGraphSdkClient(credential!, sdkOptions) : undefined),
    writeSpecFile: dependencies.writeSpecFile ?? defaultWriteSpecFile,
    providers: dependencies.providers
  });

  for (const [name, value] of Object.entries(result.outputs)) {
    actionCore.setOutput(name, value);
  }

  const ambiguityResolution = result.resolution;
  if (
    result.mode !== 'discover-many' &&
    ambiguityResolution?.status === 'unresolved' &&
    (ambiguityResolution.rankedCandidates?.length ?? 0) >= 2
  ) {
    await appendAmbiguityStepSummary(
      {
        status: ambiguityResolution.status,
        sourceType: ambiguityResolution.sourceType,
        narrowingTier: ambiguityResolution.narrowing?.tier ?? 'none',
        candidates: ambiguityResolution.rankedCandidates ?? [],
        probes: ambiguityResolution.providerProbes ?? []
      },
      process.env,
      (message) => actionCore.warning(message)
    );
  }

  actionCore.info(
    result.mode === 'discover-estate'
      ? `Discovered ${result.estate?.length ?? 0} repo association(s)`
      : result.mode === 'discover-many'
      ? `Discovered ${result.discovered.length} service(s)`
      : `Resolution status: ${result.resolution?.status ?? 'unresolved'} (${result.resolution?.sourceType ?? 'manual-review'})`
  );

  return result.discovered;
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runAction().catch((error) => {
    const message = formatUserSafeError(error);
    core.setFailed(message);
  });
}

export * from './runtime.js';
export { chooseSource } from './lib/resolve/source-selector.js';
export {
  rankServiceCandidates,
  resolveServiceCandidate,
  toAmbiguousViews,
  type AzureCandidateInput,
  type RankedServiceCandidate
} from './lib/resolve/service-resolver.js';
export { runNarrowingPipeline, type NarrowingCandidate, type NarrowingResult } from './lib/resolve/narrowing-pipeline.js';
export { buildCandidateQuery, escapeKqlString } from './lib/resolve/resource-graph-query.js';
export { collectRepoSignals } from './lib/repo/signals.js';
export { scanAzureIac, type IacScanResult, type IacFingerprint } from './lib/repo/azure-iac-scanner.js';
export { findExistingRepoSpecTyped, type RepoSpecMatch } from './lib/repo/specs.js';
export { ApimProvider, buildApimApiArmId } from './lib/providers/apim.js';
export { ApiCenterProvider, parseApiCenterDefinitionArmId, safeNativeFilename } from './lib/providers/api-center.js';
export { ApiCenterSdkClient, extractApiCenterExportPayload } from './lib/azure/api-center-client.js';
export { AppServiceProvider } from './lib/providers/app-service.js';
export { RuntimeDeclaredRoutesProvider } from './lib/providers/runtime-declared-routes.js';
export { IacLocalProvider } from './lib/providers/iac-local.js';
export { fetchSpecFromUrl, SpecFetchError } from './lib/fetch/spec-fetcher.js';
export { parseAndValidateOpenApi } from './lib/spec/validate-openapi.js';
export { deriveOpenApiDocument, type OpenApiDerivationInput, type OpenApiDerivationResult } from './lib/spec/oas-derivation.js';
export { renderAmbiguityStepSummary, appendAmbiguityStepSummary } from './lib/logging/step-summary.js';
export const outputNames = contractOutputNames;
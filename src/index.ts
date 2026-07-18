// GitHub Action shell -- see runtime.ts for the core execution logic (execute, resolveInputs).
import * as core from '@actions/core';

import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';

import { contractOutputNames, type DiscoveredService } from './contracts.js';
import { resolveActionVersion } from './action-version.js';
import {
  ApimSdkClient,
  AppServiceSdkClient,
  createAzureCredential,
  SubscriptionsSdkClient,
  type AzureApimClient,
  type AzureAppServiceClient,
  type AzureSubscriptionsClient
} from './lib/azure/clients.js';
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
  writeSpecFile?: (outputPath: string, content: string) => Promise<void>;
  providers?: SpecProvider[];
}

export async function runAction(
  actionCore: CoreLike = core,
  dependencies: GitHubActionDependencies = {}
): Promise<DiscoveredService[]> {
  const telemetry = createTelemetryContext({
    action: 'azure-spec-discovery',
    actionVersion: resolveActionVersion(),
    logger: actionCore
  });
  telemetry.setTeamId(resolveTelemetryTeamId(process.env));
  const postmanApiKey = getInput('postman-api-key');
  const postmanAccessToken = getInput('postman-access-token');
  if (postmanApiKey) {
    actionCore.setSecret?.(postmanApiKey);
  }
  if (postmanAccessToken) {
    actionCore.setSecret?.(postmanAccessToken);
  }
  const { accountType } = await prepareTelemetryCredentials({
    postmanApiKey,
    postmanAccessToken,
    onToken: (token) => actionCore.setSecret?.(token)
  });
  try {
    const result = await runActionInner(actionCore, dependencies);
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
  dependencies: GitHubActionDependencies = {}
): Promise<DiscoveredService[]> {
  const inputs = readActionInputs(actionCore);
  const credential = dependencies.subscriptions ? undefined : createAzureCredential();
  const sdkOptions = { requestTimeoutMs: inputs.requestTimeoutMs, maxAttempts: inputs.maxAttempts };

  const result = await execute(inputs, {
    core: actionCore,
    subscriptions: dependencies.subscriptions ?? new SubscriptionsSdkClient(credential!),
    createApimClient:
      dependencies.createApimClient ?? ((subscriptionId) => new ApimSdkClient(credential!, subscriptionId, sdkOptions)),
    createAppServiceClient:
      dependencies.createAppServiceClient ??
      ((subscriptionId) => new AppServiceSdkClient(credential!, subscriptionId, sdkOptions)),
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
    result.mode === 'discover-many'
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
export { AppServiceProvider } from './lib/providers/app-service.js';
export { IacLocalProvider } from './lib/providers/iac-local.js';
export { fetchSpecFromUrl } from './lib/fetch/spec-fetcher.js';
export { parseAndValidateOpenApi } from './lib/spec/validate-openapi.js';
export { deriveOpenApiDocument, type OpenApiDerivationInput, type OpenApiDerivationResult } from './lib/spec/oas-derivation.js';
export { renderAmbiguityStepSummary, appendAmbiguityStepSummary } from './lib/logging/step-summary.js';
export const outputNames = contractOutputNames;

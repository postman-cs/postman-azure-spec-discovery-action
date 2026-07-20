import path from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  actionContract,
  type ActionMode,
  type DiscoveredService,
  type ExportSummary,
  type ProviderProbeResult,
  type ResolutionResult,
  type SpecFormat
} from './contracts.js';
import type {
  AzureApimClient,
  AzureAppServiceClient,
  AzureAppServiceRuntimeClient,
  AzureCustomApisClient,
  AzureLogicAppsNativeClient,
  AzureLogicWorkflowsClient,
  AzureResourceGraphClient,
  AzureSubscriptionsClient,
  AzureTemplateSpecsClient,
  AzureEventGridClient,
  AzureServiceBusClient,
  AzureFunctionsClient
} from './lib/azure/clients.js';
import type { AzureApiCenterClient } from './lib/azure/api-center-client.js';
import {
  sourceControlAssociationEvidence,
  sourceControlMatchesRepoContext,
  type AzureSourceControlClient,
  type SourceControlAssociation
} from './lib/azure/source-control-client.js';
import {
  RuntimeDeclaredRoutesProvider,
  type RuntimeDeclaredSpecTarget,
  type RuntimeDeclaredWorkloadKind
} from './lib/providers/runtime-declared-routes.js';
import { sanitizeLogMessage } from './lib/logging/sanitize.js';
import { detectRepoContext, type RepoContext } from './lib/repo/context.js';
import { collectRepoSignals, type RepoSignals } from './lib/repo/signals.js';
import { loadAzureResolverBinding, type AzureResolverBinding } from './lib/repo/azure-bindings.js';
import { scanAzureIac, type IacScanResult } from './lib/repo/azure-iac-scanner.js';
import type { LocalSpecCandidate, RepositoryDiscoveryResult } from './lib/repo/discovery-types.js';
import { chooseSource, sourceTypeFor } from './lib/resolve/source-selector.js';
import {
  rankServiceCandidates,
  resolveServiceCandidate,
  toAmbiguousViews,
  type AzureCandidateInput,
  type RankedServiceCandidate
} from './lib/resolve/service-resolver.js';
import { runNarrowingPipeline, type NarrowingCandidate, type NarrowingResult } from './lib/resolve/narrowing-pipeline.js';
import { buildCandidateQuery } from './lib/resolve/resource-graph-query.js';
import { enumerateEstate, parseRepoSlug, type EstateRepo } from './lib/estate/enumerate.js';
import { deriveOpenApiDocument } from './lib/spec/oas-derivation.js';
import { parseAndValidateNativeSpec } from './lib/spec/native-formats.js';
import { ApimProvider, parseApimApiArmId } from './lib/providers/apim.js';
import { ApiCenterProvider } from './lib/providers/api-center.js';
import { AppServiceProvider } from './lib/providers/app-service.js';
import { CustomApisProvider } from './lib/providers/custom-apis.js';
import { LogicAppsProvider } from './lib/providers/logic-apps.js';
import { TemplateSpecsProvider } from './lib/providers/template-specs.js';
import { EventGridProvider } from './lib/providers/event-grid.js';
import { ServiceBusProvider } from './lib/providers/service-bus.js';
import { FunctionBindingsProvider } from './lib/providers/function-bindings.js';
import { IacLocalProvider } from './lib/providers/iac-local.js';
import { resolvePathWithinRoot, writeFileWithinRoot } from './lib/utils/resolve-path-within-root.js';
import type {
  HydratingSpecProvider,
  SpecCandidate,
  SpecCandidateHeader,
  SpecExportResult,
  SpecProvider
} from './lib/providers/types.js';
import { adaptLegacyProvider, toSpecCandidate } from './lib/providers/types.js';

export interface InputReaderLike {
  getInput(name: string, options?: { required?: boolean }): string;
}

export interface ReporterLike {
  group<T>(name: string, fn: () => Promise<T>): Promise<T>;
  info(message: string): void;
  warning(message: string): void;
}

export interface ResolvedInputs {
  mode: ActionMode;
  subscriptionId?: string;
  /**
   * Explicit multi-subscription scopes from subscription-ids-json after
   * normalize/dedupe-reject/sort. Empty means use singular or single-enabled behavior.
   */
  subscriptionIds: string[];
  resourceGroup?: string;
  apiId?: string;
  apiCenterDefinitionId?: string;
  environment?: string;
  gatewayId?: string;
  apiVersion?: string;
  apiRevision?: string;
  repoRoot: string;
  repoContext: RepoContext;
  expectedServiceName?: string;
  expectedApiIds: string[];
  apiFilter?: RegExp;
  serviceMapping: Record<string, string>;
  /** Extra select-grade repo tag keys beside postman:repo (CLI-only repo-tag-keys-json). */
  repoTagKeys: string[];
  outputDir: string;
  maxCandidates: number;
  dryRun: boolean;
  preflightChecks: boolean;
  preflightPermissionProbe: boolean;
  requestTimeoutMs: number;
  maxAttempts: number;
  /** Opt-in Consumption Logic Apps listSwagger. Default false. */
  enableLogicAppsListSwagger: boolean;
  /** Fail on malformed native swagger instead of synthesizing. Default false. */
  requireLogicAppsNativeSwagger: boolean;
  /** Opt-in App Service SCM ApiSpecPath byte fetch. Default false. */
  enableAppServiceScmSpecFetch: boolean;
  /** Opt-in Functions OpenAPI extension detection/export. Default false. */
  enableFunctionsOpenApiExtension: boolean;
  /** Opt-in runtime-declared HTTPS spec routes. Default false. */
  enableRuntimeDeclaredSpecRoutes: boolean;
  /** Explicit runtime-declared targets (ignored unless enabled). */
  runtimeDeclaredSpecTargets: RuntimeDeclaredSpecTarget[];
}

export interface AzureDependencies {
  core: ReporterLike;
  subscriptions: AzureSubscriptionsClient;
  createApimClient: (subscriptionId: string) => AzureApimClient;
  createAppServiceClient: (subscriptionId: string) => AzureAppServiceClient;
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
  writeSpecFile: (outputPath: string, content: string, rootPath: string) => Promise<void>;
  providers?: SpecProvider[];
}

export interface ExecutionResult {
  mode: ActionMode;
  discovered: DiscoveredService[];
  resolution?: ResolutionResult;
  exportSummary?: ExportSummary;
  estate?: EstateRepo[];
  outputs: Record<string, string>;
}

const DEFAULT_OUTPUT_DIR = 'discovered-specs';
const DEFAULT_REPO_ROOT = '.';
const MINIMUM_RESOLVED_CONFIDENCE = 40;

export function getInput(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[`INPUT_${name.replace(/-/g, '_').toUpperCase()}`];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeInputValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(input: string | undefined, inputName: string, fallback: boolean): boolean {
  if (!input) return fallback;
  const value = input.toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(value)) return false;
  throw new Error(`${inputName} must be a boolean-like value, got: ${input}`);
}

function parseBoundedInteger(input: string | undefined, inputName: string, fallback: number, min: number, max: number): number {
  if (!input) return fallback;
  if (!/^\d+$/.test(input)) {
    throw new Error(`${inputName} must be a non-negative integer between ${min} and ${max}, got: ${input}`);
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${inputName} must be a non-negative integer between ${min} and ${max}, got: ${input}`);
  }
  return value;
}

function parseMode(input: string | undefined): ActionMode {
  const value = (input ?? '').trim().toLowerCase();
  if (!value) return 'resolve-one';
  if (value === 'resolve-one' || value === 'discover-many' || value === 'discover-estate') return value;
  throw new Error(`mode must be resolve-one, discover-many, or discover-estate, got: ${input}`);
}

function parseServiceMapping(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for service-mapping-json: ${detail}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('service-mapping-json must be a JSON object keyed by API id');
  }
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v).trim()]));
}

function parseStringArrayJson(raw: string, inputName: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for ${inputName}: ${detail}`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${inputName} must be a JSON array`);
  }
  return parsed.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

/**
 * Parse subscription-ids-json. Empty/missing yields []. Rejects non-arrays, empty
 * entries, and case-insensitive duplicates. Surviving IDs are sorted lexically
 * (case-insensitive) for stable behavior and output.
 */
function parseSubscriptionIdsJson(raw: string | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for subscription-ids-json: ${detail}`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error('subscription-ids-json must be a JSON array');
  }
  const trimmed = parsed.map((value) => String(value).trim());
  if (trimmed.some((value) => value.length === 0)) {
    throw new Error('subscription-ids-json must not contain empty subscription IDs');
  }
  if (trimmed.length === 0) return [];
  const seen = new Map<string, string>();
  for (const id of trimmed) {
    const key = id.toLowerCase();
    if (seen.has(key)) {
      throw new Error('subscription-ids-json contains duplicate subscription IDs after normalization');
    }
    seen.set(key, id);
  }
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function assertSubscriptionInputCompatibility(subscriptionId: string | undefined, subscriptionIds: string[]): void {
  if (!subscriptionId || subscriptionIds.length === 0) return;
  if (
    subscriptionIds.length !== 1 ||
    subscriptionIds[0]!.toLowerCase() !== subscriptionId.toLowerCase()
  ) {
    throw new Error(
      'subscription-id and subscription-ids-json conflict unless both identify exactly the same one subscription ID'
    );
  }
}

const RUNTIME_WORKLOAD_KINDS = new Set<RuntimeDeclaredWorkloadKind>([
  'app-service',
  'functions',
  'container-apps',
  'static-web-apps',
  'aci',
  'aks'
]);

function parseRuntimeDeclaredTargets(raw: string): RuntimeDeclaredSpecTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for runtime-declared-spec-targets-json: ${detail}`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error('runtime-declared-spec-targets-json must be a JSON array');
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`runtime-declared-spec-targets-json[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    const workloadKind = typeof record.workloadKind === 'string' ? record.workloadKind.trim() : '';
    if (!id || !name || !url || !workloadKind) {
      throw new Error(
        `runtime-declared-spec-targets-json[${index}] requires id, name, workloadKind, and url`
      );
    }
    if (!RUNTIME_WORKLOAD_KINDS.has(workloadKind as RuntimeDeclaredWorkloadKind)) {
      throw new Error(
        `runtime-declared-spec-targets-json[${index}] has unsupported workloadKind "${workloadKind}"`
      );
    }
    return {
      id,
      name,
      url,
      workloadKind: workloadKind as RuntimeDeclaredWorkloadKind,
      ...(typeof record.resourceId === 'string' ? { resourceId: record.resourceId } : {}),
      ...(typeof record.resourceGroup === 'string' ? { resourceGroup: record.resourceGroup } : {}),
      ...(record.tags && typeof record.tags === 'object' && !Array.isArray(record.tags)
        ? { tags: Object.fromEntries(Object.entries(record.tags as Record<string, unknown>).map(([k, v]) => [k, String(v)])) }
        : {}),
      ...(typeof record.providerResourceType === 'string'
        ? { providerResourceType: record.providerResourceType }
        : {}),
      ...(Array.isArray(record.evidence)
        ? { evidence: record.evidence.map((value) => String(value)) }
        : {})
    };
  });
}

export function resolveInputs(env: NodeJS.ProcessEnv = process.env): ResolvedInputs {
  const mode = parseMode(getInput('mode', env));
  const subscriptionId = getInput('subscription-id', env);
  const subscriptionIds = parseSubscriptionIdsJson(getInput('subscription-ids-json', env));
  assertSubscriptionInputCompatibility(subscriptionId, subscriptionIds);
  const resourceGroup = getInput('resource-group', env);
  const apiId = getInput('api-id', env);
  const apiCenterDefinitionId = getInput('api-center-definition-id', env);
  const repoRoot =
    getInput('repo-root', env) ??
    normalizeInputValue(env.GITHUB_WORKSPACE) ??
    normalizeInputValue(env.CI_PROJECT_DIR) ??
    normalizeInputValue(env.BITBUCKET_CLONE_DIR) ??
    normalizeInputValue(env.BUILD_SOURCESDIRECTORY) ??
    DEFAULT_REPO_ROOT;
  const expectedServiceName = getInput('expected-service-name', env);
  const expectedApiIdsRaw = getInput('expected-api-ids-json', env) ?? '[]';
  const apiFilterRaw = getInput('api-filter', env);
  const serviceMappingRaw = getInput('service-mapping-json', env) ?? '{}';
  const outputDir = getInput('output-dir', env) ?? DEFAULT_OUTPUT_DIR;
  const repoContext = detectRepoContext(
    {
      repoUrl: getInput('repo-url', env),
      repoSlug: getInput('repo-slug', env),
      gitProvider: getInput('git-provider', env),
      ref: getInput('ref', env),
      sha: getInput('sha', env)
    },
    env
  );

  let apiFilter: RegExp | undefined;
  if (apiFilterRaw) {
    try {
      apiFilter = new RegExp(apiFilterRaw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid regex for api-filter: ${detail}`, { cause: error });
    }
  }

  const expectedApiIds = [apiId, ...parseStringArrayJson(expectedApiIdsRaw, 'expected-api-ids-json')].filter(
    (value): value is string => Boolean(value)
  );

  const repoTagKeysRaw = getInput('repo-tag-keys-json', env) ?? '[]';
  const environment = getInput('environment', env);
  const gatewayId = getInput('gateway-id', env);
  if (gatewayId && gatewayId.toLowerCase() === 'managed') {
    throw new Error('gateway-id "managed" is not a self-hosted gateway identity; omit it or supply a real gateway id');
  }
  const apiVersion = getInput('api-version', env);
  const apiRevision = getInput('api-revision', env);

  return {
    mode,
    subscriptionId,
    subscriptionIds,
    resourceGroup,
    apiId,
    apiCenterDefinitionId,
    environment,
    gatewayId,
    apiVersion,
    apiRevision,
    repoRoot,
    repoContext,
    expectedServiceName,
    expectedApiIds: [...new Set(expectedApiIds)],
    apiFilter,
    serviceMapping: parseServiceMapping(serviceMappingRaw),
    repoTagKeys: [...new Set(parseStringArrayJson(repoTagKeysRaw, 'repo-tag-keys-json').map((key) => key.toLowerCase()))],
    outputDir,
    maxCandidates: parseBoundedInteger(getInput('max-candidates', env), 'max-candidates', 50, 1, 10000),
    dryRun: parseBoolean(getInput('dry-run', env), 'dry-run', false),
    preflightChecks: parseBoolean(getInput('preflight-checks', env), 'preflight-checks', true),
    preflightPermissionProbe: parseBoolean(getInput('preflight-permission-probe', env), 'preflight-permission-probe', true),
    requestTimeoutMs: parseBoundedInteger(getInput('request-timeout-ms', env), 'request-timeout-ms', 30000, 1, 300000),
    maxAttempts: parseBoundedInteger(getInput('max-attempts', env), 'max-attempts', 3, 1, 100),
    enableLogicAppsListSwagger: parseBoolean(
      getInput('enable-logic-apps-list-swagger', env),
      'enable-logic-apps-list-swagger',
      false
    ),
    requireLogicAppsNativeSwagger: parseBoolean(
      getInput('require-logic-apps-native-swagger', env),
      'require-logic-apps-native-swagger',
      false
    ),
    enableAppServiceScmSpecFetch: parseBoolean(
      getInput('enable-app-service-scm-spec-fetch', env),
      'enable-app-service-scm-spec-fetch',
      false
    ),
    enableFunctionsOpenApiExtension: parseBoolean(
      getInput('enable-functions-openapi-extension', env),
      'enable-functions-openapi-extension',
      false
    ),
    enableRuntimeDeclaredSpecRoutes: parseBoolean(
      getInput('enable-runtime-declared-spec-routes', env),
      'enable-runtime-declared-spec-routes',
      false
    ),
    runtimeDeclaredSpecTargets: parseRuntimeDeclaredTargets(
      getInput('runtime-declared-spec-targets-json', env) ?? '[]'
    )
  };
}

export function readActionInputs(inputReader: InputReaderLike): ResolvedInputs {
  return resolveInputs({
    ...process.env,
    INPUT_MODE: normalizeInputValue(inputReader.getInput('mode')) ?? actionContract.inputs.mode.default,
    INPUT_SUBSCRIPTION_ID: normalizeInputValue(inputReader.getInput('subscription-id')),
    INPUT_SUBSCRIPTION_IDS_JSON: normalizeInputValue(inputReader.getInput('subscription-ids-json')),
    INPUT_RESOURCE_GROUP: normalizeInputValue(inputReader.getInput('resource-group')),
    INPUT_API_ID: normalizeInputValue(inputReader.getInput('api-id')),
    INPUT_API_CENTER_DEFINITION_ID: normalizeInputValue(inputReader.getInput('api-center-definition-id')),
    INPUT_ENVIRONMENT: normalizeInputValue(inputReader.getInput('environment')),
    INPUT_GATEWAY_ID: normalizeInputValue(inputReader.getInput('gateway-id')),
    INPUT_API_VERSION: normalizeInputValue(inputReader.getInput('api-version')),
    INPUT_API_REVISION: normalizeInputValue(inputReader.getInput('api-revision')),
    INPUT_OUTPUT_DIR: normalizeInputValue(inputReader.getInput('output-dir')) ?? actionContract.inputs['output-dir'].default,
    INPUT_ENABLE_LOGIC_APPS_LIST_SWAGGER: normalizeInputValue(inputReader.getInput('enable-logic-apps-list-swagger')),
    INPUT_REQUIRE_LOGIC_APPS_NATIVE_SWAGGER: normalizeInputValue(inputReader.getInput('require-logic-apps-native-swagger')),
    INPUT_ENABLE_APP_SERVICE_SCM_SPEC_FETCH: normalizeInputValue(inputReader.getInput('enable-app-service-scm-spec-fetch')),
    INPUT_ENABLE_FUNCTIONS_OPENAPI_EXTENSION: normalizeInputValue(inputReader.getInput('enable-functions-openapi-extension')),
    INPUT_ENABLE_RUNTIME_DECLARED_SPEC_ROUTES: normalizeInputValue(inputReader.getInput('enable-runtime-declared-spec-routes')),
    INPUT_RUNTIME_DECLARED_SPEC_TARGETS_JSON: normalizeInputValue(inputReader.getInput('runtime-declared-spec-targets-json'))
  });
}

function toNarrowingCandidate(candidate: SpecCandidate): NarrowingCandidate {
  const hostnames = (candidate.meta.hostnames ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const assignedGatewayIds = (candidate.meta.assignedGatewayIds ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const tagSource =
    candidate.meta.tagSource === 'api' || candidate.meta.tagSource === 'service-inherited'
      ? candidate.meta.tagSource
      : undefined;
  return {
    id: candidate.id,
    name: candidate.name,
    resourceGroup: candidate.resourceGroup,
    tags: candidate.tags,
    tagSource,
    apiPath: candidate.meta.path,
    apiVersion: candidate.meta.apiVersion,
    apiRevision: candidate.meta.apiRevision,
    hostnames,
    assignedGatewayIds,
    serviceName: candidate.meta.serviceName,
    workspaceId: candidate.meta.workspaceId
  };
}

function normalizeRepoRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniqueExactIds(
  values: Array<string | undefined>,
  label: string
): string | undefined {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))];
  if (unique.length > 1) {
    throw new Error(
      sanitizeLogMessage(`Conflicting exact ${label} bindings in repository discovery; refusing to choose`)
    );
  }
  return unique[0];
}

function mergeBindingSelectors(
  inputs: ResolvedInputs,
  binding: AzureResolverBinding | undefined,
  discovery?: RepositoryDiscoveryResult
): {
  apiId?: string;
  apiCenterDefinitionId?: string;
  environment?: string;
  gatewayId?: string;
  apiVersion?: string;
  apiRevision?: string;
  bindingEvidence: string[];
} {
  const discoveryApim = uniqueExactIds(
    (discovery?.exactBindings ?? []).map((entry) => entry.apimApiId),
    'APIM API ID'
  );
  const discoveryCenter = uniqueExactIds(
    (discovery?.exactBindings ?? []).map((entry) => entry.apiCenterDefinitionId),
    'API Center definition ID'
  );
  const bindingEvidence = [
    ...(binding?.evidence ?? []),
    ...(discoveryApim ? [`Folded unique exact parser APIM API ID`] : []),
    ...(discoveryCenter ? [`Folded unique exact parser API Center definition ID`] : [])
  ];

  if (inputs.apiId && binding?.apimApiId && inputs.apiId !== binding.apimApiId) {
    throw new Error('Conflicting api-id input and .postman Azure resolver binding; refusing to choose');
  }
  if (
    inputs.apiCenterDefinitionId &&
    binding?.apiCenterDefinitionId &&
    inputs.apiCenterDefinitionId !== binding.apiCenterDefinitionId
  ) {
    throw new Error(
      'Conflicting api-center-definition-id input and .postman Azure resolver binding; refusing to choose'
    );
  }
  if (inputs.gatewayId && binding?.gatewayId && inputs.gatewayId !== binding.gatewayId) {
    throw new Error('Conflicting gateway-id input and .postman Azure resolver binding; refusing to choose');
  }
  if (discoveryApim && binding?.apimApiId && discoveryApim !== binding.apimApiId) {
    throw new Error(
      'Conflicting exact APIM API ID between .postman binding and repository discovery; refusing to choose'
    );
  }
  if (
    discoveryCenter &&
    binding?.apiCenterDefinitionId &&
    discoveryCenter !== binding.apiCenterDefinitionId
  ) {
    throw new Error(
      'Conflicting exact API Center definition ID between .postman binding and repository discovery; refusing to choose'
    );
  }
  if (discoveryApim && inputs.apiId && discoveryApim !== inputs.apiId) {
    throw new Error('Conflicting api-id input and exact repository discovery binding; refusing to choose');
  }
  if (discoveryCenter && inputs.apiCenterDefinitionId && discoveryCenter !== inputs.apiCenterDefinitionId) {
    throw new Error(
      'Conflicting api-center-definition-id input and exact repository discovery binding; refusing to choose'
    );
  }

  const apiId = uniqueExactIds([inputs.apiId, binding?.apimApiId, discoveryApim], 'api-id');
  const apiCenterDefinitionId = uniqueExactIds(
    [inputs.apiCenterDefinitionId, binding?.apiCenterDefinitionId, discoveryCenter],
    'api-center-definition-id'
  );
  const gatewayId = uniqueExactIds([inputs.gatewayId, binding?.gatewayId], 'gateway-id');

  return {
    apiId,
    apiCenterDefinitionId,
    environment: inputs.environment ?? binding?.environment,
    gatewayId,
    apiVersion: inputs.apiVersion ?? binding?.apiVersion,
    apiRevision: inputs.apiRevision ?? binding?.apiRevision,
    bindingEvidence
  };
}

function sanitizeTargetUrlForEvidence(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function normalizeTargetUrlKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Runtime-declared targets must be corroborated by the committed .postman
 * binding or an authorized ARM association URL. Caller JSON alone is rejected.
 */
export function corroborateRuntimeDeclaredTargets(
  inputs: ResolvedInputs,
  binding: AzureResolverBinding | undefined,
  discovery?: RepositoryDiscoveryResult
): RuntimeDeclaredSpecTarget[] {
  if (!inputs.enableRuntimeDeclaredSpecRoutes) {
    return [];
  }

  const authorizedByUrl = new Map<string, RuntimeDeclaredSpecTarget>();
  for (const target of binding?.runtimeDeclaredSpecTargets ?? []) {
    const key = normalizeTargetUrlKey(target.url);
    if (key) authorizedByUrl.set(key, target);
  }
  for (const entry of [...(discovery?.exactBindings ?? []), ...(discovery?.associations ?? [])]) {
    if (!entry.nativeSpecUrl) continue;
    const key = normalizeTargetUrlKey(entry.nativeSpecUrl);
    if (!key || authorizedByUrl.has(key)) continue;
    authorizedByUrl.set(key, {
      id: entry.serviceName ?? key,
      name: entry.serviceName ?? 'runtime-declared',
      url: entry.nativeSpecUrl,
      workloadKind: 'app-service',
      evidence: [
        `Authorized ARM/repository association URL ${sanitizeTargetUrlForEvidence(entry.nativeSpecUrl)}`
      ]
    });
  }

  const callerTargets = inputs.runtimeDeclaredSpecTargets;
  if (callerTargets.length === 0) {
    return [...authorizedByUrl.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  const corroborated: RuntimeDeclaredSpecTarget[] = [];
  for (const target of callerTargets) {
    const key = normalizeTargetUrlKey(target.url);
    if (!key || !authorizedByUrl.has(key)) {
      throw new Error(
        sanitizeLogMessage(
          'Uncorroborated runtime-declared-spec-targets-json entry rejected; targets must match a committed .postman binding or authorized ARM association URL'
        )
      );
    }
    const authorized = authorizedByUrl.get(key)!;
    corroborated.push({
      ...target,
      evidence: [
        ...(authorized.evidence ?? []),
        `Corroborated runtime-declared target ${sanitizeTargetUrlForEvidence(target.url)}`
      ]
    });
  }
  return corroborated;
}

function selectUniqueDiscoveryNativeSpecPath(
  discovery: RepositoryDiscoveryResult
): { path: string; evidence: string[] } | undefined {
  const pathBindings = [...discovery.exactBindings, ...discovery.associations]
    .map((entry) => entry.nativeSpecPath)
    .filter((value): value is string => Boolean(value))
    .map(normalizeRepoRelativePath);
  const uniquePaths = [...new Set(pathBindings)];
  if (uniquePaths.length !== 1) return undefined;
  const onlyPath = uniquePaths[0]!;
  const matches = discovery.localSpecs.filter(
    (spec) => normalizeRepoRelativePath(spec.path) === onlyPath
  );
  if (matches.length !== 1 || !matches[0]) return undefined;
  return {
    path: matches[0].path,
    evidence: [
      `Selected unique exact manifest/pipeline/IaC nativeSpecPath binding ${matches[0].path}`,
      ...matches[0].evidence
    ]
  };
}

async function resolveBoundNativeSpec(
  inputs: ResolvedInputs,
  binding: AzureResolverBinding | undefined,
  discovery?: RepositoryDiscoveryResult
): Promise<ResolutionResult | undefined> {
  const discoverySelection = discovery ? selectUniqueDiscoveryNativeSpecPath(discovery) : undefined;
  const relativePath = binding?.nativeSpecPath
    ? normalizeRepoRelativePath(binding.nativeSpecPath)
    : discoverySelection?.path;
  if (!relativePath) return undefined;

  const absolutePath = resolvePathWithinRoot(inputs.repoRoot, relativePath, 'nativeSpecPath');
  let content: string;
  let format: SpecFormat;
  try {
    content = await readFile(absolutePath, 'utf8');
    const validated = parseAndValidateNativeSpec(content);
    format = validated.format;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      sanitizeLogMessage(
        `Exact nativeSpecPath could not be read as a supported native specification: ${detail}`
      )
    );
  }
  const matchedLocal = discovery?.localSpecs.find(
    (spec) => normalizeRepoRelativePath(spec.path) === relativePath
  );
  return {
    status: 'resolved',
    sourceType: 'repo-spec',
    serviceName: inputs.expectedServiceName ?? inputs.repoContext.repoSlug?.split('/').pop() ?? 'repository-spec',
    confidence: 100,
    specPath: relativePath,
    specFormat: format,
    evidence: [
      ...(binding?.evidence ?? []),
      ...(discoverySelection?.evidence ?? []),
      ...(matchedLocal?.evidence ?? []),
      `Resolved exact native repository specification ${relativePath} as ${format}`
    ]
  };
}

function localSpecsToRankedViews(localSpecs: LocalSpecCandidate[]): RankedServiceCandidate[] {
  return localSpecs.map((spec, index) => ({
    serviceName: path.posix.basename(spec.path),
    resourceId: spec.path,
    providerType: 'iac-local' as const,
    confidence: Math.max(0, 100 - index),
    supported: true,
    ambiguous: localSpecs.length > 1,
    evidence: [...spec.evidence, `Local specification rank score ${spec.rankScore}`]
  }));
}

/**
 * Resolve the target subscription. An explicit ID is verified with subscriptions.get;
 * when the credential lacks direct get() rights (401/403), fall back to list() and
 * accept the explicit ID only if it appears among the listed subscriptions. An omitted
 * ID selects the only enabled subscription, or fails with an exact sanitized message.
 */
export async function resolveSubscriptionId(
  explicitSubscriptionId: string | undefined,
  subscriptions: AzureSubscriptionsClient
): Promise<string> {
  if (explicitSubscriptionId) {
    try {
      await subscriptions.get(explicitSubscriptionId);
      return explicitSubscriptionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/\b(401|403)\b/.test(message)) {
        throw error;
      }
      const listed = await subscriptions.list();
      const match = listed.find(
        (subscription) => subscription.subscriptionId.toLowerCase() === explicitSubscriptionId.toLowerCase()
      );
      if (!match) {
        throw new Error(
          'The explicit --subscription-id could not be verified: direct lookup was denied and the subscription is not visible via listing.'
        );
      }
      return explicitSubscriptionId;
    }
  }
  const enabled = (await subscriptions.list()).filter(
    (subscription) => (subscription.state ?? 'Enabled').toLowerCase() === 'enabled'
  );
  if (enabled.length === 1 && enabled[0]) {
    return enabled[0].subscriptionId;
  }
  if (enabled.length === 0) {
    throw new Error('No enabled Azure subscriptions were found; pass --subscription-id after authenticating.');
  }
  throw new Error('Multiple enabled Azure subscriptions were found; pass --subscription-id explicitly.');
}

/**
 * Resolve one or more selected subscription scopes. Explicit subscription-ids-json
 * entries are verified independently (never auto-enumerating every visible
 * subscription). Empty explicit lists keep singular / single-enabled behavior.
 */
export async function resolveSubscriptionIds(
  selection: { subscriptionId?: string; subscriptionIds?: string[] },
  subscriptions: AzureSubscriptionsClient
): Promise<string[]> {
  const explicit = selection.subscriptionIds ?? [];
  if (explicit.length > 0) {
    const ordered = [...explicit].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const verified: string[] = [];
    for (const id of ordered) {
      verified.push(await resolveSubscriptionId(id, subscriptions));
    }
    return verified;
  }
  return [await resolveSubscriptionId(selection.subscriptionId, subscriptions)];
}

function scopedAbsenceEvidence(subscriptionCount: number, resourceGroup?: string): string {
  const groupNote = resourceGroup ? ', resource-group scoped' : '';
  return `No visible candidates in selected scope(s) (${subscriptionCount} subscription(s)${groupNote})`;
}

function subscriptionIdFromArmId(armId: string): string | undefined {
  const match = /^\/subscriptions\/([^/]+)/i.exec(armId);
  return match?.[1];
}

function mergeCandidatesByArmId(candidates: SpecCandidate[]): SpecCandidate[] {
  const byId = new Map<string, SpecCandidate>();
  for (const candidate of candidates) {
    const key = candidate.id.toLowerCase();
    if (!byId.has(key)) {
      byId.set(key, candidate);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

interface BoundProvider {
  subscriptionId?: string;
  provider: SpecProvider;
}

function findBoundProvider(bound: BoundProvider[], candidate: SpecCandidate): SpecProvider | undefined {
  const sub = subscriptionIdFromArmId(candidate.id)?.toLowerCase();
  const sameType = bound.filter((entry) => entry.provider.type === candidate.providerType);
  if (sub) {
    const scoped = sameType.find((entry) => entry.subscriptionId?.toLowerCase() === sub);
    if (scoped) return scoped.provider;
    // A full ARM ID must never fall through to another subscription's client.
    // Unscoped entries are test/injection seams and remain valid for existing
    // provider-injection callers; production entries are all subscription-bound.
    return sameType.find((entry) => !entry.subscriptionId)?.provider;
  }
  return sameType.find((entry) => !entry.subscriptionId)?.provider ?? sameType[0]?.provider;
}

function findApimProviderForArmId(bound: BoundProvider[], armId: string): ApimProvider | undefined {
  const sub = subscriptionIdFromArmId(armId)?.toLowerCase();
  for (const entry of bound) {
    if (!(entry.provider instanceof ApimProvider)) continue;
    if (sub && entry.subscriptionId && entry.subscriptionId.toLowerCase() !== sub) continue;
    return entry.provider;
  }
  return undefined;
}

function findApiCenterProviderForArmId(bound: BoundProvider[], armId: string): ApiCenterProvider | undefined {
  const sub = subscriptionIdFromArmId(armId)?.toLowerCase();
  for (const entry of bound) {
    if (!(entry.provider instanceof ApiCenterProvider)) continue;
    if (sub && entry.subscriptionId && entry.subscriptionId.toLowerCase() !== sub) continue;
    return entry.provider;
  }
  return undefined;
}

export async function defaultWriteSpecFile(outputPath: string, content: string, rootPath: string): Promise<void> {
  await writeFileWithinRoot(rootPath, outputPath, content, 'output-dir');
}

function projectFolderName(projectName: string): string {
  const safe = projectName
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/^\.+$/, 'service')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || 'service';
}

function resolveServiceName(candidate: SpecCandidate, serviceMapping: Record<string, string>): string {
  const tagProjectName = (candidate.tags['postman:project-name'] ?? '').trim();
  if (tagProjectName) return tagProjectName;
  const tagName = (candidate.tags.Name ?? '').trim();
  if (tagName) return tagName;
  const shortId = candidate.id.split('/').pop() ?? candidate.id;
  const mapped = (serviceMapping[candidate.id] ?? serviceMapping[shortId] ?? '').trim();
  if (mapped) return mapped;
  return candidate.name;
}

interface WrittenExport {
  specPath: string;
  specFormat: SpecFormat;
  derived?: {
    path: string;
    version: '3.0.3' | '3.1.0';
    completeness: 'full' | 'partial';
    format: 'openapi-json';
    evidence: string[];
  };
}

async function writeSpecExport(
  inputs: ResolvedInputs,
  serviceName: string,
  exportResult: SpecExportResult,
  writeSpecFile: (outputPath: string, content: string, rootPath: string) => Promise<void>
): Promise<WrittenExport> {
  const folder = projectFolderName(serviceName);
  const relativeSpecPath = path.posix.join(inputs.outputDir.split(path.sep).join('/'), folder, exportResult.filename);
  const absoluteSpecPath = resolvePathWithinRoot(inputs.repoRoot, relativeSpecPath, 'output-dir');
  if (!inputs.dryRun) {
    await writeSpecFile(absoluteSpecPath, exportResult.content, inputs.repoRoot);
  }

  const written: WrittenExport = { specPath: relativeSpecPath, specFormat: exportResult.format };

  const derivation = deriveOpenApiDocument({ content: exportResult.content, format: exportResult.format, title: serviceName });
  if (derivation) {
    // Provider-declared completeness may downgrade the derivation verdict but
    // never upgrade it: a provider that synthesized a partial document keeps
    // 'partial' even when the output parses as complete OpenAPI 3.x.
    if (exportResult.completeness === 'partial' && derivation.completeness === 'full') {
      derivation.completeness = 'partial';
      derivation.evidence = [...derivation.evidence, 'Provider declared this export partial (synthesized from a non-spec surface)'];
    }
    if (derivation.completeness === 'full' && exportResult.format === 'openapi-json') {
      // Already OpenAPI 3.x JSON: the exported file itself is the derived document.
      written.derived = {
        path: relativeSpecPath,
        version: derivation.version,
        completeness: 'full',
        format: 'openapi-json',
        evidence: derivation.evidence
      };
    } else {
      const derivedRelative = path.posix.join(inputs.outputDir.split(path.sep).join('/'), folder, 'openapi.derived.json');
      const derivedAbsolute = resolvePathWithinRoot(inputs.repoRoot, derivedRelative, 'output-dir');
      if (!inputs.dryRun) {
        await writeSpecFile(derivedAbsolute, derivation.content, inputs.repoRoot);
      }
      written.derived = {
        path: derivedRelative,
        version: derivation.version,
        completeness: derivation.completeness,
        format: 'openapi-json',
        evidence: derivation.evidence
      };
    }
  }
  return written;
}

function toCandidateInput(candidate: SpecCandidate): AzureCandidateInput {
  return {
    id: candidate.id,
    name: candidate.name,
    providerType: candidate.providerType,
    apiId: candidate.apiId,
    tags: candidate.tags,
    supported: candidate.supported,
    evidence: candidate.evidence
  };
}

interface ProbeOutcome {
  providers: SpecProvider[];
  probes: ProviderProbeResult[];
}

/**
 * Probe every provider concurrently. A hung or throwing probe must never
 * block the others: each probe is raced against a deadline and a rejection
 * (providers are expected to map auth errors to 'skipped:iam' themselves)
 * degrades to 'skipped:error' instead of aborting discovery. Output order
 * stays deterministic (input order), independent of settle order.
 */
const PROBE_DEADLINE_MS = 30000;

async function probeProviders(providers: SpecProvider[], core: ReporterLike): Promise<ProbeOutcome> {
  const settled = await Promise.all(
    providers.map(async (provider): Promise<ProviderProbeResult> => {
      let timer: NodeJS.Timeout | undefined;
      const controller = new AbortController();
      try {
        const status = await Promise.race([
          provider.probe(controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`probe exceeded ${PROBE_DEADLINE_MS}ms`));
            }, PROBE_DEADLINE_MS);
          })
        ]);
        return { provider: provider.type, status };
      } catch {
        return { provider: provider.type, status: 'skipped:error' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    })
  );
  const available = providers.filter((provider, index) => settled[index]?.status === 'available');
  core.info(`Available providers: ${available.map((p) => p.type).join(', ') || 'none'}`);
  return { providers: available, probes: settled };
}

function buildCloudProvidersForSubscription(
  inputs: ResolvedInputs,
  subscriptionId: string,
  dependencies: AzureDependencies,
  functionsOpenApiPath?: string
): BoundProvider[] {
  const bound: BoundProvider[] = [
    {
      subscriptionId,
      provider: new ApimProvider(dependencies.createApimClient(subscriptionId), {
        subscriptionId,
        resourceGroup: inputs.resourceGroup
      })
    },
    ...(dependencies.createApiCenterClient
      ? [
          {
            subscriptionId,
            provider: new ApiCenterProvider(dependencies.createApiCenterClient(subscriptionId), {
              subscriptionId,
              resourceGroup: inputs.resourceGroup
            })
          }
        ]
      : []),
    {
      subscriptionId,
      provider: new AppServiceProvider(dependencies.createAppServiceClient(subscriptionId), {
        subscriptionId,
        resourceGroup: inputs.resourceGroup,
        requestTimeoutMs: inputs.requestTimeoutMs,
        enableScmSpecFetch: inputs.enableAppServiceScmSpecFetch,
        ...(dependencies.createAppServiceRuntimeClient
          ? { runtimeClient: dependencies.createAppServiceRuntimeClient(subscriptionId) }
          : {})
      })
    },
    ...(dependencies.createCustomApisClient
      ? [
          {
            subscriptionId,
            provider: new CustomApisProvider(dependencies.createCustomApisClient(subscriptionId), {
              resourceGroup: inputs.resourceGroup
            })
          }
        ]
      : []),
    ...(dependencies.createLogicWorkflowsClient
      ? [
          {
            subscriptionId,
            provider: new LogicAppsProvider(dependencies.createLogicWorkflowsClient(subscriptionId), {
              resourceGroup: inputs.resourceGroup,
              enableListSwagger: inputs.enableLogicAppsListSwagger,
              requireNativeSwagger: inputs.requireLogicAppsNativeSwagger,
              ...(dependencies.createLogicAppsNativeClient
                ? { nativeClient: dependencies.createLogicAppsNativeClient(subscriptionId) }
                : {})
            })
          }
        ]
      : []),
    ...(dependencies.createTemplateSpecsClient
      ? [
          {
            subscriptionId,
            provider: new TemplateSpecsProvider(dependencies.createTemplateSpecsClient(subscriptionId), {
              resourceGroup: inputs.resourceGroup
            })
          }
        ]
      : []),
    ...(dependencies.createEventGridClient
      ? [
          {
            subscriptionId,
            provider: new EventGridProvider(dependencies.createEventGridClient(subscriptionId), {
              resourceGroup: inputs.resourceGroup
            })
          }
        ]
      : []),
    ...(dependencies.createServiceBusClient
      ? [
          {
            subscriptionId,
            provider: new ServiceBusProvider(dependencies.createServiceBusClient(subscriptionId), {
              resourceGroup: inputs.resourceGroup
            })
          }
        ]
      : []),
    ...(dependencies.createFunctionsClient
      ? [
          {
            subscriptionId,
            provider: new FunctionBindingsProvider(dependencies.createFunctionsClient(subscriptionId), {
              resourceGroup: inputs.resourceGroup,
              enableOpenApiExtension: inputs.enableFunctionsOpenApiExtension,
              ...(inputs.enableFunctionsOpenApiExtension && functionsOpenApiPath
                ? { explicitOpenApiPath: functionsOpenApiPath }
                : {}),
              requestTimeoutMs: inputs.requestTimeoutMs
            })
          }
        ]
      : [])
  ];
  return bound;
}

function buildBoundProviders(
  inputs: ResolvedInputs,
  subscriptionIds: string[],
  dependencies: AzureDependencies,
  iacScan: IacScanResult,
  runtimeDeclaredTargets: RuntimeDeclaredSpecTarget[] = [],
  functionsOpenApiPath?: string
): BoundProvider[] {
  if (dependencies.providers) {
    return dependencies.providers.map((provider) => ({ provider }));
  }
  const bound: BoundProvider[] = [];
  for (const subscriptionId of subscriptionIds) {
    bound.push(
      ...buildCloudProvidersForSubscription(inputs, subscriptionId, dependencies, functionsOpenApiPath)
    );
  }
  bound.push({
    provider: new RuntimeDeclaredRoutesProvider({
      enabled: inputs.enableRuntimeDeclaredSpecRoutes,
      targets: runtimeDeclaredTargets,
      requestTimeoutMs: inputs.requestTimeoutMs
    })
  });
  bound.push({ provider: new IacLocalProvider(iacScan) });
  return bound;
}

/** Bounded concurrency for ARM source-control association enrichment. */
const SOURCE_CONTROL_ENRICHMENT_CONCURRENCY = 4;

interface VisibleSourceControlTarget {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
  kind: 'app-service' | 'container-apps';
  resourceId: string;
}

function parseVisibleWebOrContainerApp(resourceId: string): VisibleSourceControlTarget | undefined {
  const site = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Web\/sites\/([^/]+)/i.exec(
    resourceId
  );
  if (site) {
    return {
      subscriptionId: site[1]!,
      resourceGroup: site[2]!,
      name: site[3]!,
      kind: 'app-service',
      resourceId: `/subscriptions/${site[1]}/resourceGroups/${site[2]}/providers/Microsoft.Web/sites/${site[3]}`
    };
  }
  const ca =
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/containerApps\/([^/]+)/i.exec(
      resourceId
    );
  if (ca) {
    return {
      subscriptionId: ca[1]!,
      resourceGroup: ca[2]!,
      name: ca[3]!,
      kind: 'container-apps',
      resourceId: `/subscriptions/${ca[1]}/resourceGroups/${ca[2]}/providers/Microsoft.App/containerApps/${ca[3]}`
    };
  }
  return undefined;
}

async function mapPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

async function querySourceControlAssociations(
  targets: VisibleSourceControlTarget[],
  dependencies: AzureDependencies,
  signal?: AbortSignal
): Promise<SourceControlAssociation[]> {
  if (!dependencies.createSourceControlClient || targets.length === 0) return [];
  const byKey = new Map<string, VisibleSourceControlTarget>();
  for (const target of targets) {
    byKey.set(target.resourceId.toLowerCase(), target);
  }
  const unique = [...byKey.values()];
  const associations: SourceControlAssociation[] = [];
  await mapPool(unique, SOURCE_CONTROL_ENRICHMENT_CONCURRENCY, async (target) => {
    signal?.throwIfAborted();
    const client = dependencies.createSourceControlClient!(target.subscriptionId);
    if (target.kind === 'app-service') {
      const result = await client.getAppServiceSourceControl(target.resourceGroup, target.name, signal);
      if (result.status === 'ok') associations.push(result.association);
      return;
    }
    const results = await client.listContainerAppSourceControls(target.resourceGroup, target.name, signal);
    for (const result of results) {
      if (result.status === 'ok') associations.push(result.association);
    }
  });
  return associations;
}

/**
 * Attach matching Azure source-control repo URL/branch as association-only
 * narrowing tags/evidence. Never resolves from source-control alone.
 */
function applySourceControlAssociationsToCandidates(
  candidates: SpecCandidate[],
  associations: SourceControlAssociation[],
  inputs: ResolvedInputs
): SpecCandidate[] {
  if (associations.length === 0) return candidates;
  const byResource = new Map<string, SourceControlAssociation[]>();
  for (const association of associations) {
    const key = association.resourceId.toLowerCase();
    const list = byResource.get(key) ?? [];
    list.push(association);
    byResource.set(key, list);
  }
  return candidates.map((candidate) => {
    const coords = parseVisibleWebOrContainerApp(candidate.id);
    if (!coords) return candidate;
    const matches = (byResource.get(coords.resourceId.toLowerCase()) ?? []).filter((association) =>
      sourceControlMatchesRepoContext(association, inputs.repoContext.repoSlug, inputs.repoContext.ref)
    );
    if (matches.length === 0) return candidate;
    // Multiple matching associations remain association-only narrowing evidence.
    const slug = parseRepoSlug(inputs.repoContext.repoSlug ?? '');
    const evidence = [
      ...candidate.evidence,
      ...matches.map((association) => sourceControlAssociationEvidence(association)),
      ...(matches.length > 1
        ? [`Multiple Azure source-control associations matched ${slug ? `${slug.org}/${slug.repo}` : 'repository'}; association-only`]
        : [])
    ];
    const tags = { ...candidate.tags };
    if (slug) {
      // github:repository is generic-tier narrowing (never select-grade alone).
      tags['github:repository'] = `${slug.org}/${slug.repo}`;
    }
    return {
      ...candidate,
      tags,
      evidence,
      meta: {
        ...candidate.meta,
        sourceControlBranch: matches[0]!.branch,
        sourceControlRepoUrl: matches[0]!.repoUrl,
        sourceControlAssociationCount: String(matches.length)
      }
    };
  });
}

async function enrichCandidatesWithSourceControl(
  candidates: SpecCandidate[],
  inputs: ResolvedInputs,
  subscriptionIds: string[],
  dependencies: AzureDependencies,
  graphRows: Map<string, { resourceGroup: string; tags: Record<string, string> }>,
  core: ReporterLike
): Promise<SpecCandidate[]> {
  if (!dependencies.createSourceControlClient) return candidates;
  const selected = new Set(subscriptionIds.map((id) => id.toLowerCase()));
  const targets: VisibleSourceControlTarget[] = [];
  for (const candidate of candidates) {
    if (candidate.providerType !== 'app-service' && candidate.providerType !== 'function-bindings') {
      const ca = parseVisibleWebOrContainerApp(candidate.id);
      if (ca?.kind === 'container-apps' && selected.has(ca.subscriptionId.toLowerCase())) {
        if (!inputs.resourceGroup || ca.resourceGroup.toLowerCase() === inputs.resourceGroup.toLowerCase()) {
          targets.push(ca);
        }
      }
      continue;
    }
    const coords = parseVisibleWebOrContainerApp(candidate.id);
    if (!coords || !selected.has(coords.subscriptionId.toLowerCase())) continue;
    if (inputs.resourceGroup && coords.resourceGroup.toLowerCase() !== inputs.resourceGroup.toLowerCase()) {
      continue;
    }
    targets.push(coords);
  }
  for (const [id] of graphRows) {
    const coords = parseVisibleWebOrContainerApp(id);
    if (!coords || !selected.has(coords.subscriptionId.toLowerCase())) continue;
    if (inputs.resourceGroup && coords.resourceGroup.toLowerCase() !== inputs.resourceGroup.toLowerCase()) {
      continue;
    }
    if (coords.kind === 'container-apps' || coords.kind === 'app-service') {
      targets.push(coords);
    }
  }
  try {
    const controller = new AbortController();
    const associations = await querySourceControlAssociations(targets, dependencies, controller.signal);
    return applySourceControlAssociationsToCandidates(candidates, associations, inputs);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    core.warning(sanitizeLogMessage(`Azure source-control association enrichment failed (fail-soft): ${detail}`));
    return candidates;
  }
}

async function queryResourceGraph(
  inputs: ResolvedInputs,
  subscriptionIds: string[],
  dependencies: AzureDependencies
): Promise<Map<string, { resourceGroup: string; tags: Record<string, string> }>> {
  if (!dependencies.createResourceGraphClient || subscriptionIds.length === 0) return new Map();
  const client = dependencies.createResourceGraphClient();
  const kql = buildCandidateQuery(inputs.resourceGroup);
  const toMap = (rows: Array<{ id: string; resourceGroup: string; tags: Record<string, string> }>) =>
    new Map(rows.map((row) => [row.id.toLowerCase(), { resourceGroup: row.resourceGroup, tags: row.tags }]));

  try {
    const rows = await client.queryResources(subscriptionIds, kql);
    return toMap(rows);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (subscriptionIds.length === 1) {
      dependencies.core.warning(sanitizeLogMessage(`Resource Graph candidate query failed: ${detail}`));
      return new Map();
    }
    // Bounded deterministic per-scope aggregate when a multi-scope request fails.
    const merged = new Map<string, { resourceGroup: string; tags: Record<string, string> }>();
    let failures = 0;
    for (const subscriptionId of subscriptionIds) {
      try {
        const rows = await client.queryResources(subscriptionId, kql);
        for (const [key, value] of toMap(rows)) {
          if (!merged.has(key)) merged.set(key, value);
        }
      } catch {
        failures += 1;
      }
    }
    if (failures > 0) {
      dependencies.core.warning(
        sanitizeLogMessage(
          `Resource Graph candidate query failed for ${failures} of ${subscriptionIds.length} selected scope(s)`
        )
      );
    } else {
      dependencies.core.warning(sanitizeLogMessage(`Resource Graph candidate query failed: ${detail}`));
    }
    return merged;
  }
}

function enrichCandidatesFromGraph(
  candidates: SpecCandidate[],
  graphRows: Map<string, { resourceGroup: string; tags: Record<string, string> }>
): SpecCandidate[] {
  return candidates.map((candidate) => {
    const graph = graphRows.get(candidate.id.toLowerCase());
    if (!graph) return candidate;
    return {
      ...candidate,
      resourceGroup: candidate.resourceGroup ?? graph.resourceGroup,
      tags: { ...graph.tags, ...candidate.tags }
    };
  });
}

function applyApiFilter(candidates: SpecCandidate[], apiFilter: RegExp | undefined): SpecCandidate[] {
  if (!apiFilter) return candidates;
  return candidates.filter(
    (candidate) =>
      apiFilter.test(candidate.name) ||
      apiFilter.test(candidate.id) ||
      apiFilter.test(candidate.id.split('/').pop() ?? candidate.id)
  );
}

/**
 * Partition candidates as [tier matches in tier order, unmatched in original stable order].
 * No candidate is deleted; the cap is applied after partitioning by the caller.
 */
export function partitionCandidates(candidates: SpecCandidate[], narrowing: NarrowingResult | undefined): SpecCandidate[] {
  if (!narrowing || narrowing.apiIds.length === 0) {
    return candidates;
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const matched: SpecCandidate[] = [];
  for (const id of narrowing.apiIds) {
    const candidate = byId.get(id);
    if (candidate) matched.push(candidate);
  }
  const matchedIds = new Set(matched.map((candidate) => candidate.id));
  const unmatched = candidates.filter((candidate) => !matchedIds.has(candidate.id));
  return [...matched, ...unmatched];
}

/** Bounded concurrency for lightweight header enumeration across providers. */
const HEADER_ENUMERATION_CONCURRENCY = 4;
/** Per-provider deadline for candidate-header enumeration (abort on timeout). */
export const HEADER_ENUMERATION_DEADLINE_MS = 30000;

/** Test-only override seam for header-enumeration deadline. */
export const headerEnumerationDeadline = {
  ms: HEADER_ENUMERATION_DEADLINE_MS
};

export interface ProviderHydrationMetrics {
  /** Header counts per provider type (no resource IDs). */
  enumeratedByProvider: Record<string, number>;
  /** Hydrated candidate counts per provider type (no resource IDs). */
  hydratedByProvider: Record<string, number>;
}

function emptyHydrationMetrics(): ProviderHydrationMetrics {
  return { enumeratedByProvider: {}, hydratedByProvider: {} };
}

function metricsEvidence(metrics: ProviderHydrationMetrics): string[] {
  const enumerated = Object.entries(metrics.enumeratedByProvider)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, count]) => `${provider}=${count}`)
    .join(', ');
  const hydrated = Object.entries(metrics.hydratedByProvider)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, count]) => `${provider}=${count}`)
    .join(', ');
  return [
    `Enumerated headers by provider: ${enumerated || 'none'}`,
    `Hydrated candidates by provider: ${hydrated || 'none'}`
  ];
}

async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  };
  const width = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: width }, () => runWorker()));
  return results;
}

function stripHeaderFlag(header: SpecCandidateHeader): SpecCandidate {
  return toSpecCandidate(header);
}

interface HeaderEnumerationResult {
  adapted: HydratingSpecProvider[];
  headers: SpecCandidateHeader[];
  metrics: ProviderHydrationMetrics;
}

/**
 * Enumerate lightweight headers with bounded concurrency. Provider order in the
 * returned header list follows the input provider order (not Promise settle order).
 * Per-provider failures and timeouts are fail-soft; hung work is aborted.
 */
async function collectCandidateHeaders(
  providers: SpecProvider[],
  core: ReporterLike
): Promise<HeaderEnumerationResult> {
  const adapted = providers.map((provider) => adaptLegacyProvider(provider));
  const metrics = emptyHydrationMetrics();
  const settled = await mapWithBoundedConcurrency(
    adapted,
    HEADER_ENUMERATION_CONCURRENCY,
    async (provider) => {
      let timer: NodeJS.Timeout | undefined;
      const controller = new AbortController();
      try {
        const deadlineMs = headerEnumerationDeadline.ms;
        const headers = await Promise.race([
          provider.listCandidateHeaders(controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`candidate header enumeration exceeded ${deadlineMs}ms`));
            }, deadlineMs);
          })
        ]);
        metrics.enumeratedByProvider[provider.type] =
          (metrics.enumeratedByProvider[provider.type] ?? 0) + headers.length;
        return headers;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        core.warning(
          sanitizeLogMessage(`Provider ${provider.type} candidate enumeration failed: ${detail}`)
        );
        metrics.enumeratedByProvider[provider.type] =
          metrics.enumeratedByProvider[provider.type] ?? 0;
        return [] as SpecCandidateHeader[];
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  );
  return { adapted, headers: settled.flat(), metrics };
}

async function hydrateHeadersForProviders(
  adapted: HydratingSpecProvider[],
  headers: SpecCandidateHeader[],
  metrics: ProviderHydrationMetrics,
  options: {
    fatal: boolean;
    core: ReporterLike;
    /**
     * Select the exact provider instance for a header. This is required when
     * the same provider type is bound to multiple subscription-scoped clients.
     */
    providerForHeader?: (header: SpecCandidateHeader) => HydratingSpecProvider | undefined;
  }
): Promise<SpecCandidate[]> {
  if (headers.length === 0) return [];
  const already = headers.filter((header) => header.headerHydrated === true).map(stripHeaderFlag);
  const pending = headers.filter((header) => header.headerHydrated !== true);
  if (pending.length === 0) return already;

  const byProvider = new Map<HydratingSpecProvider, SpecCandidateHeader[]>();
  for (const header of pending) {
    const provider =
      options.providerForHeader?.(header) ?? adapted.find((entry) => entry.type === header.providerType);
    if (!provider) {
      if (options.fatal) {
        throw new Error(`No provider is bound for selected ${header.providerType} candidate ${header.id}`);
      }
      options.core.warning(sanitizeLogMessage(`No provider is bound for ${header.providerType} candidate; skipping hydration`));
      continue;
    }
    const list = byProvider.get(provider) ?? [];
    list.push(header);
    byProvider.set(provider, list);
  }

  const hydrated: SpecCandidate[] = [...already];
  for (const [provider, group] of [...byProvider.entries()].sort(([a, aGroup], [b, bGroup]) => {
    const aKey = `${a.type}:${aGroup[0]?.id ?? ''}`;
    const bKey = `${b.type}:${bGroup[0]?.id ?? ''}`;
    return aKey.localeCompare(bKey);
  })) {
    const providerType = provider.type;
    try {
      const batch = await provider.hydrateCandidates(group);
      metrics.hydratedByProvider[providerType] =
        (metrics.hydratedByProvider[providerType] ?? 0) + batch.length;
      hydrated.push(...batch);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (options.fatal) {
        throw new Error(sanitizeLogMessage(`Hydration failed for selected ${providerType} candidate(s): ${detail}`), {
          cause: error
        });
      }
      options.core.warning(
        sanitizeLogMessage(`Provider ${providerType} hydration failed (unselected/fail-soft): ${detail}`)
      );
    }
  }
  return hydrated;
}

/** @deprecated Prefer collectCandidateHeaders; retained for exact-id injected fallbacks. */
async function collectCandidates(
  providers: SpecProvider[],
  core: ReporterLike
): Promise<SpecCandidate[]> {
  const { adapted, headers, metrics } = await collectCandidateHeaders(providers, core);
  return hydrateHeadersForProviders(adapted, headers, metrics, { fatal: false, core });
}

async function runResolveOne(inputs: ResolvedInputs, dependencies: AzureDependencies): Promise<ExecutionResult> {
  const core = dependencies.core;

  // Exact repository state is loaded before any local-spec winner decision.
  // A malformed, conflicting, or escaping binding is a configuration error, not
  // evidence to silently ignore.
  const bindingResult = await loadAzureResolverBinding(inputs.repoRoot);
  if (bindingResult.status === 'error') {
    throw new Error(sanitizeLogMessage(bindingResult.reason));
  }
  const binding = bindingResult.status === 'ok' ? bindingResult.binding : undefined;

  // Aggregate discovery (localSpecs + exact bindings) replaces first-match
  // findExistingRepoSpecTyped selection.
  const iacScan = await scanAzureIac(inputs.repoRoot, inputs.outputDir);
  const discovery = iacScan.discovery ?? {
    localSpecs: [],
    exactBindings: [],
    associations: [],
    diagnostics: {
      scannedFiles: 0,
      truncatedByFileCap: false,
      truncatedByDepth: false,
      skippedSecretFiles: [],
      messages: []
    }
  };
  const selectors = mergeBindingSelectors(inputs, binding, discovery);
  const runtimeDeclaredTargets = corroborateRuntimeDeclaredTargets(inputs, binding, discovery);

  // Exact .postman / unique manifest-pipeline-IaC nativeSpecPath resolves with
  // no Azure/network calls for all supported native formats.
  const boundNativeSpec = await resolveBoundNativeSpec(inputs, binding, discovery);
  if (boundNativeSpec) {
    return {
      mode: inputs.mode,
      discovered: [],
      resolution: boundNativeSpec,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution: boundNativeSpec })
    };
  }

  const localSpecs = discovery.localSpecs;
  if (localSpecs.length === 1 && localSpecs[0]) {
    const only = localSpecs[0];
    const resolution = chooseSource({
      existingSpecPath: only.path,
      existingSpecFormat: only.format,
      existingSpecEvidence: only.evidence,
      fallbackServiceName: inputs.expectedServiceName ?? inputs.repoContext.repoSlug?.split('/').pop()
    });
    return {
      mode: inputs.mode,
      discovered: [],
      resolution,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
    };
  }
  if (localSpecs.length > 1) {
    const ranked = localSpecsToRankedViews(localSpecs);
    const resolution: ResolutionResult = {
      status: 'unresolved',
      sourceType: 'manual-review',
      serviceName: inputs.expectedServiceName ?? 'unknown-service',
      confidence: ranked[0]?.confidence ?? 0,
      rankedCandidates: toAmbiguousViews(ranked),
      evidence: [
        `Repository contains ${localSpecs.length} valid local specifications; refusing to guess without a unique exact nativeSpecPath binding`,
        ...localSpecs.map((spec) => spec.path)
      ]
    };
    return {
      mode: inputs.mode,
      discovered: [],
      resolution,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
    };
  }

  // Repo-local IaC scan (fingerprint + inline candidates).
  const iacCandidates = iacScan.candidates;
  if (iacCandidates.length === 1 && iacCandidates[0]) {
    const only = iacCandidates[0];
    const provider = new IacLocalProvider(iacScan);
    const exportResult = await provider.exportSpec(only);
    const serviceName = resolveServiceName(only, inputs.serviceMapping);
    const written = await writeSpecExport(inputs, serviceName, exportResult, dependencies.writeSpecFile);
    const resolution: ResolutionResult = {
      status: 'resolved',
      sourceType: 'iac-embedded',
      serviceName,
      confidence: 100,
      specPath: written.specPath,
      providerType: 'iac-local',
      specFormat: written.specFormat,
      ...(written.derived
        ? {
            derivedOpenApiPath: written.derived.path,
            derivedOpenApiVersion: written.derived.version,
            derivedOpenApiCompleteness: written.derived.completeness,
            derivedOpenApiFormat: written.derived.format,
            derivedOpenApiEvidence: written.derived.evidence
          }
        : {}),
      evidence: [...only.evidence, ...exportResult.evidence]
    };
    return {
      mode: inputs.mode,
      discovered: [],
      resolution,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
    };
  }
  if (iacCandidates.length > 1) {
    const signals = await collectRepoSignals({
      repoRoot: inputs.repoRoot,
      expectedServiceName: inputs.expectedServiceName,
      expectedApiIds: inputs.expectedApiIds,
      repoSlug: inputs.repoContext.repoSlug
    });
    const ranked = rankServiceCandidates(iacCandidates.map(toCandidateInput), signals);
    const resolution: ResolutionResult = {
      status: 'unresolved',
      sourceType: 'manual-review',
      serviceName: inputs.expectedServiceName ?? 'unknown-service',
      confidence: ranked[0]?.confidence ?? 0,
      rankedCandidates: toAmbiguousViews(ranked),
      evidence: [`Repository IaC contains ${iacCandidates.length} inline OpenAPI documents; refusing to guess between them`]
    };
    return {
      mode: inputs.mode,
      discovered: [],
      resolution,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
    };
  }

  // 3. Cloud discovery across selected subscription scope(s).
  if (selectors.apiId && selectors.apiCenterDefinitionId) {
    throw new Error(
      'Conflicting api-id and api-center-definition-id selectors; refuse to choose between APIM and API Center exact sources'
    );
  }
  const subscriptionIds = await resolveSubscriptionIds(
    { subscriptionId: inputs.subscriptionId, subscriptionIds: inputs.subscriptionIds },
    dependencies.subscriptions
  );
  const subscriptionId = subscriptionIds[0]!;
  const graphRows = await queryResourceGraph(inputs, subscriptionIds, dependencies);
  const boundProviders = buildBoundProviders(
    inputs,
    subscriptionIds,
    dependencies,
    iacScan,
    runtimeDeclaredTargets,
    binding?.functionsOpenApiPath
  );
  const { providers: availableProviders, probes } = await core.group('Probe available providers', () =>
    probeProviders(
      boundProviders.map((entry) => entry.provider),
      core
    )
  );
  const availableBound = boundProviders.filter((entry) =>
    availableProviders.some((provider) => provider === entry.provider)
  );

  const signals = await collectRepoSignals({
    repoRoot: inputs.repoRoot,
    expectedServiceName: inputs.expectedServiceName,
    expectedApiIds: selectors.apiId ? [...inputs.expectedApiIds, selectors.apiId] : inputs.expectedApiIds,
    repoSlug: inputs.repoContext.repoSlug
  });

  // 3a0. Exact API Center definition ID / binding wins over cloud ranking.
  if (selectors.apiCenterDefinitionId) {
    const requestedDefinitionId = selectors.apiCenterDefinitionId;
    const apiCenter = findApiCenterProviderForArmId(availableBound, requestedDefinitionId);
    // A complete definition ARM id supplies every export coordinate.  Resolve it
    // directly rather than inventorying all services/versions and risking a
    // first/latest selection among otherwise ambiguous definitions.
    // Test/injected providers only implement the public SpecProvider seam, so
    // retain exact-id filtering there. Production ApiCenterProvider never needs
    // broad inventory for a complete definition ARM id.
    const injectedApiCenter = !apiCenter
      ? availableBound.find((entry) => entry.provider.type === 'api-center')?.provider
      : undefined;
    const target = apiCenter
      ? apiCenter.resolveExplicitDefinition(requestedDefinitionId)
      : (await collectCandidates(injectedApiCenter ? [injectedApiCenter] : [], core)).find(
          (candidate) => candidate.id === requestedDefinitionId || candidate.apiId === requestedDefinitionId
        );
    if (!target) {
      const resolution: ResolutionResult = {
        status: 'unresolved',
        sourceType: 'manual-review',
        serviceName: inputs.expectedServiceName ?? 'unknown-service',
        confidence: 0,
        providerProbes: probes,
        evidence: [
          ...selectors.bindingEvidence,
          'Requested api-center-definition-id is invalid, outside the selected scope, or API Center is unavailable'
        ]
      };
      return {
        mode: inputs.mode,
        discovered: [],
        resolution,
        outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
      };
    }
    const provider = apiCenter ?? injectedApiCenter;
    if (!provider) {
      const resolution: ResolutionResult = {
        status: 'unresolved',
        sourceType: 'manual-review',
        serviceName: resolveServiceName(target, inputs.serviceMapping),
        confidence: 0,
        providerProbes: probes,
        evidence: [
          ...selectors.bindingEvidence,
          'API Center provider is unavailable; cannot export the requested definition'
        ]
      };
      return {
        mode: inputs.mode,
        discovered: [],
        resolution,
        outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
      };
    }
    const exportResult = await provider.exportSpec(target);
    const serviceName = resolveServiceName(target, inputs.serviceMapping);
    const written = await writeSpecExport(inputs, serviceName, exportResult, dependencies.writeSpecFile);
    const selectionEvidence =
      selectors.bindingEvidence.length > 0
        ? selectors.bindingEvidence
        : ['Caller-selected API Center definition ID'];
    const resolution: ResolutionResult = {
      status: 'resolved',
      sourceType: 'api-center-export',
      serviceName,
      confidence: 100,
      specPath: written.specPath,
      ...(target.apiId ? { apiId: target.apiId } : {}),
      providerType: 'api-center',
      specFormat: written.specFormat,
      ...(exportResult.contractClass ? { contractClass: exportResult.contractClass } : {}),
      ...(written.derived
        ? {
            derivedOpenApiPath: written.derived.path,
            derivedOpenApiVersion: written.derived.version,
            derivedOpenApiCompleteness: written.derived.completeness,
            derivedOpenApiFormat: written.derived.format,
            derivedOpenApiEvidence: written.derived.evidence
          }
        : {}),
      providerProbes: probes,
      evidence: [...selectionEvidence, ...target.evidence, ...exportResult.evidence]
    };
    return {
      mode: inputs.mode,
      discovered: [],
      resolution,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
    };
  }

  const {
    adapted: adaptedProviders,
    headers: rawHeaders,
    metrics: hydrationMetrics
  } = await collectCandidateHeaders(availableProviders, core);
  const adaptedByInstance = new Map(
    availableProviders.map((provider, index) => [provider, adaptedProviders[index]!])
  );
  const adaptedProviderForHeader = (header: SpecCandidateHeader): HydratingSpecProvider | undefined => {
    const provider = findBoundProvider(availableBound, stripHeaderFlag(header));
    return provider ? adaptedByInstance.get(provider) : undefined;
  };
  const graphEnrichedHeaders: SpecCandidateHeader[] = applyApiFilter(
    mergeCandidatesByArmId(
      enrichCandidatesFromGraph(rawHeaders.map(stripHeaderFlag), graphRows)
    ).map((candidate) => {
      const original = rawHeaders.find((header) => header.id === candidate.id);
      return {
        ...candidate,
        headerHydrated: original?.headerHydrated === true
      } satisfies SpecCandidateHeader;
    }),
    inputs.apiFilter
  ).map((candidate) => {
    const original = rawHeaders.find((header) => header.id === candidate.id);
    return {
      ...candidate,
      headerHydrated: original?.headerHydrated === true
    } satisfies SpecCandidateHeader;
  });
  const sourceControlEnriched = await core.group('Enrich Azure source-control associations', () =>
    enrichCandidatesWithSourceControl(
      graphEnrichedHeaders.map(stripHeaderFlag),
      inputs,
      subscriptionIds,
      dependencies,
      graphRows,
      core
    )
  );
  const hydratedFlags = new Map(
    graphEnrichedHeaders.map((header) => [header.id, header.headerHydrated === true] as const)
  );
  const headerList = sourceControlEnriched.map(
    (candidate) =>
      ({
        ...candidate,
        headerHydrated: hydratedFlags.get(candidate.id) === true
      }) satisfies SpecCandidateHeader
  );
  // Ranking/narrowing operate over the full uncapped header set.
  const enumerated = headerList.map(stripHeaderFlag);

  const hydrateSelected = async (selectedHeaders: SpecCandidateHeader[]): Promise<SpecCandidate[]> =>
    hydrateHeadersForProviders(adaptedProviders, selectedHeaders, hydrationMetrics, {
      fatal: true,
      core,
      providerForHeader: adaptedProviderForHeader
    });

  // 3a. Explicit api-id / exact binding is a caller selection with confidence 100.
  if (selectors.apiId) {
    const requestedApiId = selectors.apiId;
    const isFullArmId = /^\/subscriptions\//i.test(requestedApiId);
    let targetHeader: SpecCandidateHeader | undefined;
    if (isFullArmId) {
      targetHeader = headerList.find(
        (candidate) =>
          candidate.apiId?.toLowerCase() === requestedApiId.toLowerCase() ||
          candidate.id.toLowerCase() === requestedApiId.toLowerCase()
      );
      // Historical ;rev=N may be absent from current-revision enumeration.
      if (!targetHeader && /;rev=\d+/i.test(requestedApiId) && parseApimApiArmId(requestedApiId)) {
        const apim = findApimProviderForArmId(availableBound, requestedApiId);
        if (apim) {
          const explicit = await apim.resolveExplicitApi(requestedApiId);
          if (explicit) targetHeader = { ...explicit, headerHydrated: true };
        }
      }
    } else {
      const requestedShort = requestedApiId.split('/').pop();
      const shortMatches = headerList.filter(
        (candidate) =>
          (candidate.apiId ?? '').split('/').pop() === requestedShort ||
          candidate.id.split('/').pop() === requestedShort
      );
      if (shortMatches.length === 1) {
        targetHeader = shortMatches[0];
      } else if (shortMatches.length > 1) {
        const ambiguousRanked = rankServiceCandidates(shortMatches.map(toCandidateInput), signals);
        const ambiguousResolution: ResolutionResult = {
          status: 'unresolved',
          sourceType: 'manual-review',
          serviceName: inputs.expectedServiceName ?? 'unknown-service',
          confidence: ambiguousRanked[0]?.confidence ?? 0,
          providerProbes: probes,
          rankedCandidates: toAmbiguousViews(ambiguousRanked),
          evidence: [
            `Requested api-id matched ${shortMatches.length} APIs by short name; refusing to guess between them`,
            ...metricsEvidence(hydrationMetrics)
          ]
        };
        return {
          mode: inputs.mode,
          discovered: [],
          resolution: ambiguousResolution,
          outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution: ambiguousResolution })
        };
      }
    }
    let target = targetHeader ? stripHeaderFlag(targetHeader) : undefined;
    if (targetHeader && targetHeader.headerHydrated !== true) {
      const hydrated = await hydrateSelected([targetHeader]);
      target = hydrated.find(
        (candidate) =>
          candidate.id === targetHeader!.id ||
          candidate.apiId?.toLowerCase() === requestedApiId.toLowerCase()
      );
    }
    if (target && !target.supported) {
      const resolution: ResolutionResult = {
        status: 'unresolved',
        sourceType: 'manual-review',
        serviceName: resolveServiceName(target, inputs.serviceMapping),
        confidence: 100,
        providerProbes: probes,
        rankedCandidates: toAmbiguousViews(rankServiceCandidates([toCandidateInput(target)], signals)),
        evidence: [...selectors.bindingEvidence, ...target.evidence, ...metricsEvidence(hydrationMetrics)]
      };
      return {
        mode: inputs.mode,
        discovered: [],
        resolution,
        outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
      };
    }
    if (
      target &&
      ((selectors.apiVersion && target.meta.apiVersion !== selectors.apiVersion) ||
        (selectors.apiRevision && String(target.meta.apiRevision ?? '') !== String(selectors.apiRevision)))
    ) {
      const requested = [
        ...(selectors.apiVersion ? [`api-version=${selectors.apiVersion}`] : []),
        ...(selectors.apiRevision ? [`api-revision=${selectors.apiRevision}`] : [])
      ].join(', ');
      const resolution: ResolutionResult = {
        status: 'unresolved',
        sourceType: 'manual-review',
        serviceName: resolveServiceName(target, inputs.serviceMapping),
        confidence: 0,
        providerProbes: probes,
        rankedCandidates: toAmbiguousViews(rankServiceCandidates([toCandidateInput(target)], signals)),
        evidence: [
          ...selectors.bindingEvidence,
          `Caller-selected API does not match requested ${requested}; refusing to export a different version or revision`,
          ...metricsEvidence(hydrationMetrics)
        ]
      };
      return {
        mode: inputs.mode,
        discovered: [],
        resolution,
        outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
      };
    }
    if (target) {
      const provider =
        findBoundProvider(availableBound, target) ??
        (target.providerType === 'apim' ? findApimProviderForArmId(availableBound, target.id) : undefined);
      if (provider) {
        const exportResult = await provider.exportSpec(target);
        const serviceName = resolveServiceName(target, inputs.serviceMapping);
        const written = await writeSpecExport(inputs, serviceName, exportResult, dependencies.writeSpecFile);
        const selectionEvidence = selectors.bindingEvidence.length > 0
          ? selectors.bindingEvidence
          : [`Caller-selected API ID`];
        const resolution: ResolutionResult = {
          status: 'resolved',
          sourceType: sourceTypeFor(target.providerType),
          serviceName,
          confidence: 100,
          specPath: written.specPath,
          ...(target.apiId ? { apiId: target.apiId } : {}),
          providerType: target.providerType,
          specFormat: written.specFormat,
          ...(exportResult.contractClass ? { contractClass: exportResult.contractClass } : {}),
          ...(written.derived
            ? {
                derivedOpenApiPath: written.derived.path,
                derivedOpenApiVersion: written.derived.version,
                derivedOpenApiCompleteness: written.derived.completeness,
                derivedOpenApiFormat: written.derived.format,
                derivedOpenApiEvidence: written.derived.evidence
              }
            : {}),
          providerProbes: probes,
          evidence: [
            ...selectionEvidence,
            ...target.evidence,
            ...exportResult.evidence,
            ...metricsEvidence(hydrationMetrics)
          ]
        };
        return {
          mode: inputs.mode,
          discovered: [],
          resolution,
          outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
        };
      }
    }
    const resolution: ResolutionResult = {
      status: 'unresolved',
      sourceType: 'manual-review',
      serviceName: inputs.expectedServiceName ?? 'unknown-service',
      confidence: 0,
      providerProbes: probes,
      evidence: [
        ...selectors.bindingEvidence,
        `Requested api-id was not found among ${enumerated.length} enumerated candidate(s)`,
        ...metricsEvidence(hydrationMetrics)
      ]
    };
    return {
      mode: inputs.mode,
      discovered: [],
      resolution,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
    };
  }

  // 3b. Narrow and rank over all headers before any selected hydration.
  const narrowing = await runNarrowingPipeline(
    {
      repoSlug: inputs.repoContext.repoSlug,
      subscriptionId,
      subscriptionIds,
      resourceGroup: inputs.resourceGroup,
      repoTagKeys: inputs.repoTagKeys,
      environment: selectors.environment,
      gatewayId: selectors.gatewayId,
      apiVersion: selectors.apiVersion,
      apiRevision: selectors.apiRevision,
      serviceHints: signals.serviceHints,
      signals,
      resourceGraphClient: dependencies.createResourceGraphClient?.()
    },
    enumerated.map(toNarrowingCandidate)
  );

  const partitionedHeaders = partitionCandidates(headerList, narrowing) as SpecCandidateHeader[];
  const partitioned = partitionedHeaders.map(stripHeaderFlag);
  // Correctness decision (ranking + ambiguity) runs across every partitioned
  // header; the cap only bounds the serialized rankedCandidates view.
  const cappedCount = Math.max(0, partitioned.length - inputs.maxCandidates);

  const ranked = rankServiceCandidates(partitioned.map(toCandidateInput), signals);

  // A single exact canonical-tag selection has confidence 100.
  let best: RankedServiceCandidate | undefined;
  if (narrowing?.mode === 'select' && narrowing.apiIds.length === 1) {
    best = ranked.find((candidate) => candidate.resourceId === narrowing.apiIds[0]);
    if (best) {
      best.confidence = 100;
      best.ambiguous = false;
      best.evidence = [...best.evidence, ...narrowing.evidence];
    }
  }
  if (!best) {
    best = resolveServiceCandidate(partitioned.map(toCandidateInput), signals);
    if (best && narrowing) {
      best.evidence = [...best.evidence, ...narrowing.evidence];
    }
  }

  const narrowingMetadata = narrowing
    ? { tier: narrowing.tier, mode: narrowing.mode, droppedCount: narrowing.droppedCount }
    : undefined;

  const topConfidence = ranked[0]?.confidence;
  const tiedTop =
    topConfidence === undefined
      ? []
      : ranked.filter((candidate) => candidate.confidence === topConfidence && candidate.supported);
  const selectedHeaderIds = new Set<string>();
  if (best && !best.ambiguous && best.supported && best.confidence >= MINIMUM_RESOLVED_CONFIDENCE) {
    selectedHeaderIds.add(best.resourceId);
  } else if (tiedTop.length > 1) {
    for (const entry of tiedTop) selectedHeaderIds.add(entry.resourceId);
  }

  let workingCandidates = partitioned;
  let workingRanked = ranked;
  let workingBest = best;

  if (selectedHeaderIds.size > 0) {
    const selectedHeaders = partitionedHeaders.filter((header) => selectedHeaderIds.has(header.id));
    const hydratedSelected = await hydrateSelected(selectedHeaders);
    // Replace selected headers with hydrated rows (may expand, e.g. template specs).
    const selectedIdSet = selectedHeaderIds;
    const untouched = partitioned.filter((candidate) => !selectedIdSet.has(candidate.id));
    workingCandidates = [...hydratedSelected, ...untouched];
    workingRanked = rankServiceCandidates(workingCandidates.map(toCandidateInput), signals);
    workingBest = undefined;
    if (narrowing?.mode === 'select' && narrowing.apiIds.length === 1) {
      workingBest = workingRanked.find((candidate) => candidate.resourceId === narrowing.apiIds[0]);
      if (workingBest) {
        workingBest.confidence = 100;
        workingBest.ambiguous = false;
        workingBest.evidence = [...workingBest.evidence, ...narrowing.evidence];
      }
    }
    if (!workingBest) {
      workingBest = resolveServiceCandidate(workingCandidates.map(toCandidateInput), signals);
      if (workingBest && narrowing) {
        workingBest.evidence = [...workingBest.evidence, ...narrowing.evidence];
      }
    }
    workingRanked.sort(
      (left, right) =>
        right.confidence - left.confidence ||
        (left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0)
    );
    // Hydration changed support/identity or preserved same-rank ambiguity → fail closed.
    const hydratedTopConfidence = workingRanked[0]?.confidence;
    const hydratedTies =
      hydratedTopConfidence === undefined
        ? []
        : workingRanked.filter(
            (candidate) => candidate.confidence === hydratedTopConfidence && candidate.supported
          );
    if (
      !workingBest ||
      workingBest.ambiguous ||
      !workingBest.supported ||
      workingBest.confidence < MINIMUM_RESOLVED_CONFIDENCE ||
      hydratedTies.length > 1
    ) {
      const resolution: ResolutionResult = {
        status: 'unresolved',
        sourceType: 'manual-review',
        serviceName: inputs.expectedServiceName ?? workingBest?.serviceName ?? 'unknown-service',
        confidence: workingBest?.confidence ?? 0,
        ...(narrowingMetadata ? { narrowing: narrowingMetadata } : {}),
        providerProbes: probes,
        rankedCandidates: toAmbiguousViews(workingRanked.slice(0, inputs.maxCandidates)),
        evidence: [
          ...(workingBest?.evidence ?? [scopedAbsenceEvidence(subscriptionIds.length, inputs.resourceGroup)]),
          'Selected hydration did not yield a unique supported winner; refusing to guess',
          ...metricsEvidence(hydrationMetrics),
          ...(cappedCount > 0
            ? [
                `Candidate cap hid ${cappedCount} lower-ranked candidate(s) from the serialized view (ranking used all candidates)`
              ]
            : [])
        ]
      };
      return {
        mode: inputs.mode,
        discovered: [],
        resolution,
        outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
      };
    }
  }

  if (
    workingBest &&
    !workingBest.ambiguous &&
    workingBest.supported &&
    workingBest.confidence >= MINIMUM_RESOLVED_CONFIDENCE
  ) {
    const target = workingCandidates.find((candidate) => candidate.id === workingBest?.resourceId);
    const provider = target ? findBoundProvider(availableBound, target) : undefined;
    if (target && provider) {
      try {
        // Ensure the export target was hydrated when detail was deferred.
        const adapted = adaptedByInstance.get(provider);
        if (adapted && target.meta.hydrationPending === 'true') {
          const [hydratedTarget] = await hydrateSelected([{ ...target, headerHydrated: false }]);
          if (hydratedTarget) {
            Object.assign(target, hydratedTarget);
          }
        }
        const exportResult = await provider.exportSpec(target);
        const serviceName = resolveServiceName(target, inputs.serviceMapping);
        const written = await writeSpecExport(inputs, serviceName, exportResult, dependencies.writeSpecFile);
        const resolution: ResolutionResult = {
          status: 'resolved',
          sourceType: sourceTypeFor(target.providerType),
          serviceName,
          confidence: workingBest.confidence,
          specPath: written.specPath,
          ...(target.apiId ? { apiId: target.apiId } : {}),
          providerType: target.providerType,
          specFormat: written.specFormat,
          ...(exportResult.contractClass ? { contractClass: exportResult.contractClass } : {}),
          ...(written.derived
            ? {
                derivedOpenApiPath: written.derived.path,
                derivedOpenApiVersion: written.derived.version,
                derivedOpenApiCompleteness: written.derived.completeness,
                derivedOpenApiFormat: written.derived.format,
                derivedOpenApiEvidence: written.derived.evidence
              }
            : {}),
          ...(narrowingMetadata ? { narrowing: narrowingMetadata } : {}),
          providerProbes: probes,
          evidence: [...workingBest.evidence, ...metricsEvidence(hydrationMetrics)]
        };
        return {
          mode: inputs.mode,
          discovered: [],
          resolution,
          outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
        };
      } catch (error) {
        // The candidate resolved unambiguously; a failed export is a real
        // failure, not "nothing to onboard". Fail the step instead of silently
        // degrading to unresolved (which the composite pipeline treats as skip).
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          sanitizeLogMessage(`Export failed for resolved candidate ${workingBest.serviceName}: ${detail}`),
          { cause: error }
        );
      }
    }
  }

  // 3c. Manual review with capped ranked view.
  const resolution: ResolutionResult = {
    status: 'unresolved',
    sourceType: 'manual-review',
    serviceName: inputs.expectedServiceName ?? workingBest?.serviceName ?? 'unknown-service',
    confidence: workingBest?.confidence ?? 0,
    ...(narrowingMetadata ? { narrowing: narrowingMetadata } : {}),
    providerProbes: probes,
    rankedCandidates: toAmbiguousViews(workingRanked.slice(0, inputs.maxCandidates)),
    evidence: [
      ...(workingBest?.evidence ?? [scopedAbsenceEvidence(subscriptionIds.length, inputs.resourceGroup)]),
      ...metricsEvidence(hydrationMetrics),
      ...(cappedCount > 0
        ? [
            `Candidate cap hid ${cappedCount} lower-ranked candidate(s) from the serialized view (ranking used all candidates)`
          ]
        : [])
    ]
  };
  return {
    mode: inputs.mode,
    discovered: [],
    resolution,
    outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
  };
}

async function runDiscoverMany(inputs: ResolvedInputs, dependencies: AzureDependencies): Promise<ExecutionResult> {
  const core = dependencies.core;
  const bindingResult = await loadAzureResolverBinding(inputs.repoRoot);
  if (bindingResult.status === 'error') {
    throw new Error(sanitizeLogMessage(bindingResult.reason));
  }
  const binding = bindingResult.status === 'ok' ? bindingResult.binding : undefined;
  const iacScan = await scanAzureIac(inputs.repoRoot, inputs.outputDir);
  const runtimeDeclaredTargets = corroborateRuntimeDeclaredTargets(inputs, binding, iacScan.discovery);
  const subscriptionIds = await resolveSubscriptionIds(
    { subscriptionId: inputs.subscriptionId, subscriptionIds: inputs.subscriptionIds },
    dependencies.subscriptions
  );
  const subscriptionId = subscriptionIds[0]!;
  const graphRows = await queryResourceGraph(inputs, subscriptionIds, dependencies);
  const boundProviders = buildBoundProviders(
    inputs,
    subscriptionIds,
    dependencies,
    iacScan,
    runtimeDeclaredTargets,
    binding?.functionsOpenApiPath
  );
  const { providers: availableProviders, probes } = await core.group('Probe available providers', () =>
    probeProviders(
      boundProviders.map((entry) => entry.provider),
      core
    )
  );
  const availableBound = boundProviders.filter((entry) =>
    availableProviders.some((provider) => provider === entry.provider)
  );

  const {
    adapted: adaptedProviders,
    headers: rawHeaders,
    metrics: hydrationMetrics
  } = await collectCandidateHeaders(availableProviders, core);
  const adaptedByInstance = new Map(
    availableProviders.map((provider, index) => [provider, adaptedProviders[index]!])
  );
  const adaptedProviderForHeader = (header: SpecCandidateHeader): HydratingSpecProvider | undefined => {
    const provider = findBoundProvider(availableBound, stripHeaderFlag(header));
    return provider ? adaptedByInstance.get(provider) : undefined;
  };
  const graphEnrichedHeaders: SpecCandidateHeader[] = applyApiFilter(
    mergeCandidatesByArmId(
      enrichCandidatesFromGraph(rawHeaders.map(stripHeaderFlag), graphRows)
    ).map((candidate) => {
      const original = rawHeaders.find((header) => header.id === candidate.id);
      return {
        ...candidate,
        headerHydrated: original?.headerHydrated === true
      } satisfies SpecCandidateHeader;
    }),
    inputs.apiFilter
  ).map((candidate) => {
    const original = rawHeaders.find((header) => header.id === candidate.id);
    return {
      ...candidate,
      headerHydrated: original?.headerHydrated === true
    } satisfies SpecCandidateHeader;
  });
  const sourceControlEnriched = await core.group('Enrich Azure source-control associations', () =>
    enrichCandidatesWithSourceControl(
      graphEnrichedHeaders.map(stripHeaderFlag),
      inputs,
      subscriptionIds,
      dependencies,
      graphRows,
      core
    )
  );
  const hydratedFlags = new Map(
    graphEnrichedHeaders.map((header) => [header.id, header.headerHydrated === true] as const)
  );
  const headerList = sourceControlEnriched.map(
    (candidate) =>
      ({
        ...candidate,
        headerHydrated: hydratedFlags.get(candidate.id) === true
      }) satisfies SpecCandidateHeader
  );
  const enumerated = headerList.map(stripHeaderFlag);
  // R5.AC6: partition by repo narrowing BEFORE the cap so canonical-tag matches
  // survive max-candidates in discover-many exactly as they do in resolve-one.
  const signals = await collectRepoSignals({
    repoRoot: inputs.repoRoot,
    expectedServiceName: inputs.expectedServiceName,
    expectedApiIds: inputs.expectedApiIds,
    repoSlug: inputs.repoContext.repoSlug
  });
  const narrowing = await runNarrowingPipeline(
    {
      repoSlug: inputs.repoContext.repoSlug,
      subscriptionId,
      subscriptionIds,
      resourceGroup: inputs.resourceGroup,
      repoTagKeys: inputs.repoTagKeys,
      environment: inputs.environment,
      gatewayId: inputs.gatewayId,
      apiVersion: inputs.apiVersion,
      apiRevision: inputs.apiRevision,
      serviceHints: signals.serviceHints,
      signals,
      resourceGraphClient: dependencies.createResourceGraphClient?.()
    },
    enumerated.map(toNarrowingCandidate)
  );
  const partitionedHeaders = partitionCandidates(headerList, narrowing) as SpecCandidateHeader[];
  const cappedHeaders = partitionedHeaders.slice(0, inputs.maxCandidates);
  // discover-many explicitly hydrates only the post-partition/cap set.
  const capped = await hydrateHeadersForProviders(adaptedProviders, cappedHeaders, hydrationMetrics, {
    fatal: false,
    core,
    providerForHeader: adaptedProviderForHeader
  });
  core.info(sanitizeLogMessage(metricsEvidence(hydrationMetrics).join('; ')));
  const summary: ExportSummary = {
    attempted: 0,
    exported: 0,
    failed: 0,
    skipped: enumerated.length - cappedHeaders.length
  };
  const discovered: DiscoveredService[] = [];
  const writtenPaths = new Map<string, string>();

  for (const candidate of capped) {
    if (!candidate.supported) {
      summary.skipped += 1;
      continue;
    }
    const provider = findBoundProvider(availableBound, candidate);
    if (!provider) {
      summary.skipped += 1;
      continue;
    }
    summary.attempted += 1;
    try {
      const exportResult = await provider.exportSpec(candidate);
      const serviceName = resolveServiceName(candidate, inputs.serviceMapping);
      const targetPath = path.posix.join(inputs.outputDir.split(path.sep).join('/'), projectFolderName(serviceName), exportResult.filename);
      const priorOwner = writtenPaths.get(targetPath);
      if (priorOwner && priorOwner !== candidate.id) {
        // Two distinct candidates resolved to the same on-disk path; writing
        // would silently overwrite the earlier export while summary.exported
        // still counted both. Fail this one loudly instead.
        throw new Error(`Spec path collision at ${targetPath}: already written by ${priorOwner}`);
      }
      const written = await writeSpecExport(inputs, serviceName, exportResult, dependencies.writeSpecFile);
      writtenPaths.set(written.specPath, candidate.id);
      discovered.push({
        serviceName,
        specPath: written.specPath,
        ...(candidate.apiId ? { apiId: candidate.apiId } : {}),
        providerType: candidate.providerType,
        specFormat: written.specFormat,
        ...(written.derived
          ? {
              derivedOpenApiPath: written.derived.path,
              derivedOpenApiVersion: written.derived.version,
              derivedOpenApiCompleteness: written.derived.completeness,
              derivedOpenApiFormat: written.derived.format,
              derivedOpenApiEvidence: written.derived.evidence
            }
          : {})
      });
      summary.exported += 1;
    } catch (error) {
      summary.failed += 1;
      const detail = error instanceof Error ? error.message : String(error);
      core.warning(sanitizeLogMessage(`Export failed for ${candidate.name}: ${detail}`));
    }
  }

  if (summary.failed > 0) {
    core.warning(sanitizeLogMessage(`discover-many encountered ${summary.failed} export failure(s); strict mode marks resolution as unresolved`));
  }

  return {
    mode: inputs.mode,
    discovered,
    exportSummary: summary,
    outputs: buildExecutionOutputs({ mode: inputs.mode, discovered, exportSummary: summary, providerProbes: probes })
  };
}

async function enrichEstateWithSourceControl(
  estate: EstateRepo[],
  inputs: ResolvedInputs,
  subscriptionIds: string[],
  dependencies: AzureDependencies,
  core: ReporterLike
): Promise<EstateRepo[]> {
  if (!dependencies.createSourceControlClient) return estate;
  const selected = new Set(subscriptionIds.map((id) => id.toLowerCase()));
  const targets: VisibleSourceControlTarget[] = [];

  // Already-visible estate resources that are App Service / Container Apps.
  for (const entry of estate) {
    for (const resourceId of entry.resourceIds) {
      const coords = parseVisibleWebOrContainerApp(resourceId);
      if (!coords || !selected.has(coords.subscriptionId.toLowerCase())) continue;
      if (inputs.resourceGroup && coords.resourceGroup.toLowerCase() !== inputs.resourceGroup.toLowerCase()) {
        continue;
      }
      targets.push(coords);
    }
  }

  // Visible inventory within selected subscription / resource-group only (no all-sub walk).
  for (const subscriptionId of subscriptionIds) {
    try {
      if (dependencies.createAppServiceClient) {
        const sites = await dependencies.createAppServiceClient(subscriptionId).listSites(inputs.resourceGroup);
        for (const site of sites) {
          targets.push({
            subscriptionId,
            resourceGroup: site.resourceGroup,
            name: site.name,
            kind: 'app-service',
            resourceId: `/subscriptions/${subscriptionId}/resourceGroups/${site.resourceGroup}/providers/Microsoft.Web/sites/${site.name}`
          });
        }
      }
      const sourceControl = dependencies.createSourceControlClient(subscriptionId);
      const containerApps = await sourceControl.listContainerApps(inputs.resourceGroup);
      for (const app of containerApps) {
        targets.push({
          subscriptionId,
          resourceGroup: app.resourceGroup,
          name: app.name,
          kind: 'container-apps',
          resourceId: app.id
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      core.warning(
        sanitizeLogMessage(
          `Azure source-control inventory for subscription scope failed (fail-soft): ${detail}`
        )
      );
    }
  }

  let associations: SourceControlAssociation[] = [];
  try {
    associations = await querySourceControlAssociations(targets, dependencies);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    core.warning(sanitizeLogMessage(`Azure source-control estate enrichment failed (fail-soft): ${detail}`));
    return estate;
  }

  const merged = new Map<string, EstateRepo>();
  for (const entry of estate) {
    merged.set(`${entry.org.toLowerCase()}/${entry.repo.toLowerCase()}`, {
      ...entry,
      tagSources: [...entry.tagSources],
      resourceTypes: [...entry.resourceTypes],
      resourceIds: [...entry.resourceIds]
    });
  }
  for (const association of associations) {
    if (!association.org || !association.repo) continue;
    const key = `${association.org.toLowerCase()}/${association.repo.toLowerCase()}`;
    const existing = merged.get(key);
    const resourceType =
      association.kind === 'app-service' ? 'microsoft.web/sites' : 'microsoft.app/containerapps';
    if (existing) {
      if (!existing.tagSources.includes('source-control')) {
        existing.tagSources = [...existing.tagSources, 'source-control'].sort((a, b) =>
          a.localeCompare(b)
        );
      }
      if (!existing.resourceTypes.includes(resourceType)) {
        existing.resourceTypes = [...existing.resourceTypes, resourceType].sort((a, b) =>
          a.localeCompare(b)
        );
      }
      if (!existing.resourceIds.some((id) => id.toLowerCase() === association.resourceId.toLowerCase())) {
        existing.resourceIds = [...existing.resourceIds, association.resourceId].sort((a, b) =>
          a.localeCompare(b)
        );
      }
    } else {
      merged.set(key, {
        org: association.org,
        repo: association.repo,
        tagSources: ['source-control'],
        resourceTypes: [resourceType],
        resourceIds: [association.resourceId]
      });
    }
  }
  return [...merged.values()].sort((a, b) => {
    const left = `${a.org}/${a.repo}`.toLowerCase();
    const right = `${b.org}/${b.repo}`.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

async function runDiscoverEstate(inputs: ResolvedInputs, dependencies: AzureDependencies): Promise<ExecutionResult> {
  const core = dependencies.core;
  if (!dependencies.createResourceGraphClient) {
    throw new Error('discover-estate requires a Resource Graph client');
  }
  const subscriptionIds = await resolveSubscriptionIds(
    { subscriptionId: inputs.subscriptionId, subscriptionIds: inputs.subscriptionIds },
    dependencies.subscriptions
  );
  const taggedEstate = await core.group('Enumerate estate repo associations', () =>
    enumerateEstate(dependencies.createResourceGraphClient!(), subscriptionIds, inputs.resourceGroup)
  );
  const estate = await core.group('Enrich Azure source-control associations', () =>
    enrichEstateWithSourceControl(taggedEstate, inputs, subscriptionIds, dependencies, core)
  );
  core.info(sanitizeLogMessage(`discover-estate found ${estate.length} repo association(s)`));

  if (!inputs.dryRun) {
    const reposPath = path.join(inputs.repoRoot, inputs.outputDir, 'repos.json');
    const writeSpecFile = dependencies.writeSpecFile ?? defaultWriteSpecFile;
    await writeSpecFile(reposPath, `${JSON.stringify(estate, null, 2)}\n`, inputs.repoRoot);
  }

  return {
    mode: inputs.mode,
    discovered: [],
    estate,
    outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], estate })
  };
}

export function buildExecutionOutputs(result: {
  mode: ActionMode;
  discovered: DiscoveredService[];
  resolution?: ResolutionResult;
  exportSummary?: ExportSummary;
  providerProbes?: ProviderProbeResult[];
  estate?: EstateRepo[];
}): Record<string, string> {
  if (result.mode === 'discover-estate') {
    const estate = result.estate ?? [];
    return {
      'resolution-json': JSON.stringify({
        status: 'resolved',
        sourceType: 'discover-estate',
        repoCount: estate.length
      }),
      'resolution-status': 'resolved',
      'source-type': 'discover-estate',
      'mapping-confidence': '0',
      'spec-path': '',
      'api-id': '',
      'service-name': '',
      'services-json': '[]',
      'service-count': '0',
      'export-summary-json': JSON.stringify({ attempted: 0, exported: 0, failed: 0, skipped: 0 }),
      'candidates-json': '',
      'provider-type': '',
      'spec-format': '',
      'contract-origin': '',
      'contract-metadata-path': '',
      'variant-count': '',
      'derived-openapi-path': '',
      'derived-openapi-version': '',
      'derived-openapi-completeness': '',
      'derived-openapi-format': '',
      'derived-openapi-evidence-json': '',
      'narrowing-strategy': 'none',
      'repos-json': JSON.stringify(estate),
      'repo-count': String(estate.length)
    };
  }
  if (result.mode === 'discover-many') {
    const discovered = result.discovered;
    const summary = result.exportSummary ?? { attempted: discovered.length, exported: discovered.length, failed: 0, skipped: 0 };
    const unresolved = summary.failed > 0;
    return {
      'resolution-json': JSON.stringify({
        status: unresolved ? 'unresolved' : 'resolved',
        sourceType: 'discover-many',
        count: discovered.length,
        summary,
        providerProbes: result.providerProbes ?? []
      }),
      'resolution-status': unresolved ? 'unresolved' : 'resolved',
      'source-type': 'discover-many',
      'mapping-confidence': unresolved ? '0' : discovered.length > 0 ? '100' : '0',
      'spec-path': '',
      'api-id': '',
      'service-name': '',
      'services-json': JSON.stringify(discovered),
      'service-count': String(discovered.length),
      'export-summary-json': JSON.stringify(summary),
      'candidates-json': '',
      'provider-type': discovered.length > 0 ? (discovered[0]?.providerType ?? '') : '',
      'spec-format': discovered.length > 0 ? (discovered[0]?.specFormat ?? '') : '',
      'contract-origin': '',
      'contract-metadata-path': '',
      'variant-count': '',
      'derived-openapi-path': '',
      'derived-openapi-version': '',
      'derived-openapi-completeness': '',
      'derived-openapi-format': '',
      'derived-openapi-evidence-json': '',
      'narrowing-strategy': 'none',
      'repos-json': '',
      'repo-count': ''
    };
  }

  const resolution = result.resolution ?? {
    status: 'unresolved' as const,
    sourceType: 'manual-review' as const,
    serviceName: 'unknown-service',
    confidence: 0,
    evidence: ['No resolution result produced']
  };
  const resolutionWithProbes = { ...resolution, providerProbes: resolution.providerProbes ?? result.providerProbes ?? [] };
  return {
    'resolution-json': JSON.stringify(resolutionWithProbes),
    'resolution-status': resolution.status,
    'source-type': resolution.sourceType,
    'mapping-confidence': String(resolution.confidence),
    'spec-path': resolution.specPath ?? '',
    'api-id': resolution.apiId ?? '',
    'service-name': resolution.serviceName,
    'services-json': '[]',
    'service-count': '0',
    'export-summary-json': JSON.stringify({ attempted: 0, exported: 0, failed: 0, skipped: 0 }),
    'candidates-json':
      resolution.status === 'unresolved' && (resolution.rankedCandidates?.length ?? 0) >= 2
        ? JSON.stringify(resolution.rankedCandidates)
        : '',
    'provider-type': resolution.providerType ?? '',
    'spec-format': resolution.specFormat ?? '',
    'contract-origin': '',
    'contract-metadata-path': '',
    'variant-count': '',
    'derived-openapi-path': resolution.derivedOpenApiPath ?? '',
    'derived-openapi-version': resolution.derivedOpenApiVersion ?? '',
    'derived-openapi-completeness': resolution.derivedOpenApiCompleteness ?? '',
    'derived-openapi-format': resolution.derivedOpenApiFormat ?? '',
    'derived-openapi-evidence-json': JSON.stringify(resolution.derivedOpenApiEvidence ?? []),
    'narrowing-strategy': resolution.narrowing?.tier ?? 'none',
    'repos-json': '',
    'repo-count': ''
  };
}

export async function execute(inputs: ResolvedInputs, dependencies: AzureDependencies): Promise<ExecutionResult> {
  resolvePathWithinRoot(inputs.repoRoot, inputs.outputDir, 'output-dir');
  if (inputs.mode === 'discover-estate') {
    return runDiscoverEstate(inputs, dependencies);
  }
  if (inputs.mode === 'discover-many') {
    return runDiscoverMany(inputs, dependencies);
  }
  return runResolveOne(inputs, dependencies);
}

export type { RepoSignals };

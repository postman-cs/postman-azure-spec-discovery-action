import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  AzureCustomApisClient,
  AzureLogicWorkflowsClient,
  AzureResourceGraphClient,
  AzureSubscriptionsClient,
  AzureTemplateSpecsClient,
  AzureEventGridClient,
  AzureServiceBusClient
} from './lib/azure/clients.js';
import { sanitizeLogMessage } from './lib/logging/sanitize.js';
import { detectRepoContext, type RepoContext } from './lib/repo/context.js';
import { findExistingRepoSpecTyped } from './lib/repo/specs.js';
import { collectRepoSignals, type RepoSignals } from './lib/repo/signals.js';
import { scanAzureIac, type IacScanResult } from './lib/repo/azure-iac-scanner.js';
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
import { deriveOpenApiDocument } from './lib/spec/oas-derivation.js';
import { ApimProvider } from './lib/providers/apim.js';
import { AppServiceProvider } from './lib/providers/app-service.js';
import { CustomApisProvider } from './lib/providers/custom-apis.js';
import { LogicAppsProvider } from './lib/providers/logic-apps.js';
import { TemplateSpecsProvider } from './lib/providers/template-specs.js';
import { EventGridProvider } from './lib/providers/event-grid.js';
import { ServiceBusProvider } from './lib/providers/service-bus.js';
import { IacLocalProvider } from './lib/providers/iac-local.js';
import { resolvePathWithinRoot } from './lib/utils/resolve-path-within-root.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './lib/providers/types.js';

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
  resourceGroup?: string;
  apiId?: string;
  repoRoot: string;
  repoContext: RepoContext;
  expectedServiceName?: string;
  expectedApiIds: string[];
  apiFilter?: RegExp;
  serviceMapping: Record<string, string>;
  outputDir: string;
  maxCandidates: number;
  dryRun: boolean;
  preflightChecks: boolean;
  preflightPermissionProbe: boolean;
  requestTimeoutMs: number;
  maxAttempts: number;
}

export interface AzureDependencies {
  core: ReporterLike;
  subscriptions: AzureSubscriptionsClient;
  createApimClient: (subscriptionId: string) => AzureApimClient;
  createAppServiceClient: (subscriptionId: string) => AzureAppServiceClient;
  createCustomApisClient?: (subscriptionId: string) => AzureCustomApisClient;
  createLogicWorkflowsClient?: (subscriptionId: string) => AzureLogicWorkflowsClient;
  createTemplateSpecsClient?: (subscriptionId: string) => AzureTemplateSpecsClient;
  createEventGridClient?: (subscriptionId: string) => AzureEventGridClient;
  createServiceBusClient?: (subscriptionId: string) => AzureServiceBusClient;
  createResourceGraphClient?: () => AzureResourceGraphClient;
  writeSpecFile: (outputPath: string, content: string) => Promise<void>;
  providers?: SpecProvider[];
}

export interface ExecutionResult {
  mode: ActionMode;
  discovered: DiscoveredService[];
  resolution?: ResolutionResult;
  exportSummary?: ExportSummary;
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
  if (value === 'resolve-one' || value === 'discover-many') return value;
  throw new Error(`mode must be resolve-one or discover-many, got: ${input}`);
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

export function resolveInputs(env: NodeJS.ProcessEnv = process.env): ResolvedInputs {
  const mode = parseMode(getInput('mode', env));
  const subscriptionId = getInput('subscription-id', env);
  const resourceGroup = getInput('resource-group', env);
  const apiId = getInput('api-id', env);
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

  return {
    mode,
    subscriptionId,
    resourceGroup,
    apiId,
    repoRoot,
    repoContext,
    expectedServiceName,
    expectedApiIds: [...new Set(expectedApiIds)],
    apiFilter,
    serviceMapping: parseServiceMapping(serviceMappingRaw),
    outputDir,
    maxCandidates: parseBoundedInteger(getInput('max-candidates', env), 'max-candidates', 50, 1, 10000),
    dryRun: parseBoolean(getInput('dry-run', env), 'dry-run', false),
    preflightChecks: parseBoolean(getInput('preflight-checks', env), 'preflight-checks', true),
    preflightPermissionProbe: parseBoolean(getInput('preflight-permission-probe', env), 'preflight-permission-probe', true),
    requestTimeoutMs: parseBoundedInteger(getInput('request-timeout-ms', env), 'request-timeout-ms', 30000, 1, 300000),
    maxAttempts: parseBoundedInteger(getInput('max-attempts', env), 'max-attempts', 3, 1, 100)
  };
}

export function readActionInputs(inputReader: InputReaderLike): ResolvedInputs {
  return resolveInputs({
    ...process.env,
    INPUT_MODE: normalizeInputValue(inputReader.getInput('mode')) ?? actionContract.inputs.mode.default,
    INPUT_SUBSCRIPTION_ID: normalizeInputValue(inputReader.getInput('subscription-id')),
    INPUT_RESOURCE_GROUP: normalizeInputValue(inputReader.getInput('resource-group')),
    INPUT_API_ID: normalizeInputValue(inputReader.getInput('api-id')),
    INPUT_OUTPUT_DIR: normalizeInputValue(inputReader.getInput('output-dir')) ?? actionContract.inputs['output-dir'].default
  });
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
      const match = listed.find((subscription) => subscription.subscriptionId === explicitSubscriptionId);
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

export async function defaultWriteSpecFile(outputPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
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
  writeSpecFile: (outputPath: string, content: string) => Promise<void>
): Promise<WrittenExport> {
  const folder = projectFolderName(serviceName);
  const relativeSpecPath = path.posix.join(inputs.outputDir.split(path.sep).join('/'), folder, exportResult.filename);
  const absoluteSpecPath = resolvePathWithinRoot(inputs.repoRoot, relativeSpecPath, 'output-dir');
  if (!inputs.dryRun) {
    await writeSpecFile(absoluteSpecPath, exportResult.content);
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
        await writeSpecFile(derivedAbsolute, derivation.content);
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
      try {
        const status = await Promise.race([
          provider.probe(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`probe exceeded ${PROBE_DEADLINE_MS}ms`)), PROBE_DEADLINE_MS);
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

function buildProviders(inputs: ResolvedInputs, subscriptionId: string, dependencies: AzureDependencies, iacScan: IacScanResult): SpecProvider[] {
  if (dependencies.providers) {
    return dependencies.providers;
  }
  return [
    new ApimProvider(dependencies.createApimClient(subscriptionId), {
      subscriptionId,
      resourceGroup: inputs.resourceGroup
    }),
    new AppServiceProvider(dependencies.createAppServiceClient(subscriptionId), {
      subscriptionId,
      resourceGroup: inputs.resourceGroup,
      requestTimeoutMs: inputs.requestTimeoutMs
    }),
    ...(dependencies.createCustomApisClient
      ? [new CustomApisProvider(dependencies.createCustomApisClient(subscriptionId), { resourceGroup: inputs.resourceGroup })]
      : []),
    ...(dependencies.createLogicWorkflowsClient
      ? [new LogicAppsProvider(dependencies.createLogicWorkflowsClient(subscriptionId), { resourceGroup: inputs.resourceGroup })]
      : []),
    ...(dependencies.createTemplateSpecsClient
      ? [new TemplateSpecsProvider(dependencies.createTemplateSpecsClient(subscriptionId), { resourceGroup: inputs.resourceGroup })]
      : []),
    ...(dependencies.createEventGridClient
      ? [new EventGridProvider(dependencies.createEventGridClient(subscriptionId), { resourceGroup: inputs.resourceGroup })]
      : []),
    ...(dependencies.createServiceBusClient
      ? [new ServiceBusProvider(dependencies.createServiceBusClient(subscriptionId), { resourceGroup: inputs.resourceGroup })]
      : []),
    new IacLocalProvider(iacScan)
  ];
}

async function queryResourceGraph(
  inputs: ResolvedInputs,
  subscriptionId: string,
  dependencies: AzureDependencies
): Promise<Map<string, { resourceGroup: string; tags: Record<string, string> }>> {
  if (!dependencies.createResourceGraphClient) return new Map();
  try {
    const rows = await dependencies.createResourceGraphClient().queryResources(
      subscriptionId,
      buildCandidateQuery(inputs.resourceGroup)
    );
    return new Map(
      rows.map((row) => [row.id.toLowerCase(), { resourceGroup: row.resourceGroup, tags: row.tags }])
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dependencies.core.warning(sanitizeLogMessage(`Resource Graph candidate query failed: ${detail}`));
    return new Map();
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
  return candidates.filter((candidate) => apiFilter.test(candidate.name) || apiFilter.test(candidate.id.split('/').pop() ?? candidate.id));
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

async function collectCandidates(
  providers: SpecProvider[],
  core: ReporterLike
): Promise<SpecCandidate[]> {
  const all: SpecCandidate[] = [];
  for (const provider of providers) {
    try {
      const candidates = await provider.listCandidates();
      all.push(...candidates);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      core.warning(sanitizeLogMessage(`Provider ${provider.type} candidate enumeration failed: ${detail}`));
    }
  }
  return all;
}

async function runResolveOne(inputs: ResolvedInputs, dependencies: AzureDependencies): Promise<ExecutionResult> {
  const core = dependencies.core;

  // 1. Existing repo spec always wins.
  const existingSpec = await findExistingRepoSpecTyped(inputs.repoRoot);
  if (existingSpec) {
    const resolution = chooseSource({
      existingSpecPath: existingSpec.path,
      existingSpecFormat: existingSpec.format,
      existingSpecEvidence: existingSpec.evidence,
      fallbackServiceName: inputs.expectedServiceName ?? inputs.repoContext.repoSlug?.split('/').pop()
    });
    return {
      mode: inputs.mode,
      discovered: [],
      resolution,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
    };
  }

  // 2. Repo-local IaC scan (fingerprint + inline candidates).
  const iacScan = await scanAzureIac(inputs.repoRoot, inputs.outputDir);
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

  // 3. Cloud discovery.
  const subscriptionId = await resolveSubscriptionId(inputs.subscriptionId, dependencies.subscriptions);
  const graphRows = await queryResourceGraph(inputs, subscriptionId, dependencies);
  const providers = buildProviders(inputs, subscriptionId, dependencies, iacScan);
  const { providers: availableProviders, probes } = await core.group('Probe available providers', () =>
    probeProviders(providers, core)
  );

  const signals = await collectRepoSignals({
    repoRoot: inputs.repoRoot,
    expectedServiceName: inputs.expectedServiceName,
    expectedApiIds: inputs.expectedApiIds,
    repoSlug: inputs.repoContext.repoSlug
  });

  const enumerated = applyApiFilter(
    enrichCandidatesFromGraph(await collectCandidates(availableProviders, core), graphRows),
    inputs.apiFilter
  );

  // 3a. Explicit api-id is a caller selection with confidence 100.
  if (inputs.apiId) {
    const requestedApiId = inputs.apiId;
    // A full ARM ID identifies exactly one API; matching it on the terminal
    // segment alone would let a same-named API in another service/RG win. Only
    // a bare name may match on short segment, and only when it is unique.
    const isFullArmId = requestedApiId.startsWith('/subscriptions/');
    let target: SpecCandidate | undefined;
    if (isFullArmId) {
      target = enumerated.find(
        (candidate) => candidate.apiId === requestedApiId || candidate.id === requestedApiId
      );
    } else {
      const requestedShort = requestedApiId.split('/').pop();
      const shortMatches = enumerated.filter(
        (candidate) =>
          (candidate.apiId ?? '').split('/').pop() === requestedShort ||
          candidate.id.split('/').pop() === requestedShort
      );
      if (shortMatches.length === 1) {
        target = shortMatches[0];
      } else if (shortMatches.length > 1) {
        const ambiguousRanked = rankServiceCandidates(shortMatches.map(toCandidateInput), signals);
        const ambiguousResolution: ResolutionResult = {
          status: 'unresolved',
          sourceType: 'manual-review',
          serviceName: inputs.expectedServiceName ?? 'unknown-service',
          confidence: ambiguousRanked[0]?.confidence ?? 0,
          providerProbes: probes,
          rankedCandidates: toAmbiguousViews(ambiguousRanked),
          evidence: [`Requested api-id "${requestedApiId}" matched ${shortMatches.length} APIs by short name; refusing to guess between them`]
        };
        return {
          mode: inputs.mode,
          discovered: [],
          resolution: ambiguousResolution,
          outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution: ambiguousResolution })
        };
      }
    }
    if (target && !target.supported) {
      const resolution: ResolutionResult = {
        status: 'unresolved',
        sourceType: 'manual-review',
        serviceName: resolveServiceName(target, inputs.serviceMapping),
        confidence: 100,
        providerProbes: probes,
        rankedCandidates: toAmbiguousViews(rankServiceCandidates([toCandidateInput(target)], signals)),
        evidence: target.evidence
      };
      return {
        mode: inputs.mode,
        discovered: [],
        resolution,
        outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
      };
    }
    if (target) {
      const provider = availableProviders.find((p) => p.type === target.providerType);
      if (provider) {
        const exportResult = await provider.exportSpec(target);
        const serviceName = resolveServiceName(target, inputs.serviceMapping);
        const written = await writeSpecExport(inputs, serviceName, exportResult, dependencies.writeSpecFile);
        const resolution: ResolutionResult = {
          status: 'resolved',
          sourceType: sourceTypeFor(target.providerType),
          serviceName,
          confidence: 100,
          specPath: written.specPath,
          ...(target.apiId ? { apiId: target.apiId } : {}),
          providerType: target.providerType,
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
          providerProbes: probes,
          evidence: [`Caller-selected API ID ${inputs.apiId}`, ...target.evidence, ...exportResult.evidence]
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
      evidence: [`Requested api-id was not found among ${enumerated.length} enumerated candidate(s)`]
    };
    return {
      mode: inputs.mode,
      discovered: [],
      resolution,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
    };
  }

  // 3b. Narrow, partition, cap, rank, choose.
  const narrowing = await runNarrowingPipeline(
    {
      repoSlug: inputs.repoContext.repoSlug,
      subscriptionId,
      serviceHints: signals.serviceHints,
      signals
    },
    enumerated.map((candidate): NarrowingCandidate => ({
      id: candidate.id,
      name: candidate.name,
      resourceGroup: candidate.resourceGroup,
      tags: candidate.tags
    }))
  );

  const partitioned = partitionCandidates(enumerated, narrowing);
  // Correctness decision (ranking + ambiguity) runs across every partitioned
  // candidate; the cap only bounds the serialized rankedCandidates view. Capping
  // before ranking could drop a tied candidate and fabricate a unique winner.
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

  if (best && !best.ambiguous && best.supported && best.confidence >= MINIMUM_RESOLVED_CONFIDENCE) {
    const target = partitioned.find((candidate) => candidate.id === best?.resourceId);
    const provider = target ? availableProviders.find((p) => p.type === target.providerType) : undefined;
    if (target && provider) {
      try {
        const exportResult = await provider.exportSpec(target);
        const serviceName = resolveServiceName(target, inputs.serviceMapping);
        const written = await writeSpecExport(inputs, serviceName, exportResult, dependencies.writeSpecFile);
        const resolution: ResolutionResult = {
          status: 'resolved',
          sourceType: sourceTypeFor(target.providerType),
          serviceName,
          confidence: best.confidence,
          specPath: written.specPath,
          ...(target.apiId ? { apiId: target.apiId } : {}),
          providerType: target.providerType,
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
          ...(narrowingMetadata ? { narrowing: narrowingMetadata } : {}),
          providerProbes: probes,
          evidence: best.evidence
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
        throw new Error(sanitizeLogMessage(`Export failed for resolved candidate ${best.serviceName}: ${detail}`), { cause: error });
      }
    }
  }

  // 3c. Manual review with capped ranked view.
  const resolution: ResolutionResult = {
    status: 'unresolved',
    sourceType: 'manual-review',
    serviceName: inputs.expectedServiceName ?? best?.serviceName ?? 'unknown-service',
    confidence: best?.confidence ?? 0,
    ...(narrowingMetadata ? { narrowing: narrowingMetadata } : {}),
    providerProbes: probes,
    rankedCandidates: toAmbiguousViews(ranked.slice(0, inputs.maxCandidates)),
    evidence: [
      ...(best?.evidence ?? ['No candidates matched this repository']),
      ...(cappedCount > 0 ? [`Candidate cap hid ${cappedCount} lower-ranked candidate(s) from the serialized view (ranking used all candidates)`] : [])
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
  const iacScan = await scanAzureIac(inputs.repoRoot, inputs.outputDir);
  const subscriptionId = await resolveSubscriptionId(inputs.subscriptionId, dependencies.subscriptions);
  const graphRows = await queryResourceGraph(inputs, subscriptionId, dependencies);
  const providers = buildProviders(inputs, subscriptionId, dependencies, iacScan);
  const { providers: availableProviders, probes } = await core.group('Probe available providers', () =>
    probeProviders(providers, core)
  );

  const enumerated = applyApiFilter(
    enrichCandidatesFromGraph(await collectCandidates(availableProviders, core), graphRows),
    inputs.apiFilter
  );
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
      serviceHints: signals.serviceHints,
      signals
    },
    enumerated.map((candidate): NarrowingCandidate => ({
      id: candidate.id,
      name: candidate.name,
      resourceGroup: candidate.resourceGroup,
      tags: candidate.tags
    }))
  );
  const partitioned = partitionCandidates(enumerated, narrowing);
  const capped = partitioned.slice(0, inputs.maxCandidates);
  const summary: ExportSummary = { attempted: 0, exported: 0, failed: 0, skipped: enumerated.length - capped.length };
  const discovered: DiscoveredService[] = [];
  const writtenPaths = new Map<string, string>();

  for (const candidate of capped) {
    if (!candidate.supported) {
      summary.skipped += 1;
      continue;
    }
    const provider = availableProviders.find((p) => p.type === candidate.providerType);
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

export function buildExecutionOutputs(result: {
  mode: ActionMode;
  discovered: DiscoveredService[];
  resolution?: ResolutionResult;
  exportSummary?: ExportSummary;
  providerProbes?: ProviderProbeResult[];
}): Record<string, string> {
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
      'narrowing-strategy': 'none'
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
    'narrowing-strategy': resolution.narrowing?.tier ?? 'none'
  };
}

export async function execute(inputs: ResolvedInputs, dependencies: AzureDependencies): Promise<ExecutionResult> {
  resolvePathWithinRoot(inputs.repoRoot, inputs.outputDir, 'output-dir');
  if (inputs.mode === 'discover-many') {
    return runDiscoverMany(inputs, dependencies);
  }
  return runResolveOne(inputs, dependencies);
}

export type { RepoSignals };

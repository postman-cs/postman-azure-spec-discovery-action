#!/usr/bin/env node
/* global console, process, URL */
// Live Azure validation runner (R8 / POS-396).
//
// Operator-triggered only; never wired into pull-request CI. Preferred path is
// Azure DevOps pipeline id 157 (`postman-azure-spec-discovery-live-validation`)
// in PostmanDevOps/CSE Pilots, service connection `azure-cse-pilot-builders`.
// That pipeline enforces an exact immutable githubRef; this harness records only
// a short commit correlation hash (or suite/case-set version), never raw IDs.
//
// Local equivalent (only when already authenticated as that same service-
// connection identity — never a personal subscription):
//   npm run build
//   AZURE_LOCATION=eastus2 \
//     node validation/scripts/validate-live-azure-surfaces.mjs --provision --teardown
//
// Dry-run / render (no Azure credentials):
//   node validation/scripts/validate-live-azure-surfaces.mjs --dry-run --render-plan
//
// Cancellation recovery (re-enter teardown for a prior run marker):
//   AZURE_LIVE_RESUME_SUFFIX=... AZURE_LIVE_RESUME_MARKER=... \
//     node validation/scripts/validate-live-azure-surfaces.mjs --teardown --cancel-recover

import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

const repoRoot = process.cwd();
export const SUITE_VERSION = 'r8-pos-396-v1';
export const EVIDENCE_SCHEMA_VERSION = 2;
export const API_CENTER_LOCATION = 'eastus';
export const RUN_MARKER_TAG = 'postman-azure-spec-discovery-live-run';
export const RESOURCE_RUN_MARKER_TAG = 'postman:run-marker';
export const PIPELINE_ID = 157;
export const PIPELINE_NAME = 'postman-azure-spec-discovery-live-validation';

const APIM_READY_TIMEOUT_MS = 5 * 60 * 1000;
const APIM_POLL_INTERVAL_MS = 5 * 1000;
const CLEANUP_READY_TIMEOUT_MS = 5 * 60 * 1000;
const CLEANUP_POLL_INTERVAL_MS = 5 * 1000;
export const STUB_HEALTH_TIMEOUT_MS = 120_000;
export const STUB_HEALTH_POLL_INTERVAL_MS = 5_000;
export const CASE_MATRIX_CONCURRENCY = 4;
export const CUSTOM_CONNECTOR_TIMEOUT_MS = 30_000;
export const EXTENDED_DEPLOYMENT_TIMEOUT_MS = 120_000;

/** Exact public-Azure safe matrix size; coverage gate rejects drift. */
export const EXPECTED_CASE_CATALOG_SIZE = 31;

/**
 * Machine-readable case catalog for the public-Azure safe matrix.
 * `claimFacets` is required when more than one route-claims row maps to the same case id.
 */
export const CASE_CATALOG = Object.freeze([
  // Baseline six (retained)
  { id: 'apim-explicit-api-id', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'baseline' },
  { id: 'apim-discovery', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'baseline' },
  { id: 'app-service-api-definition', providerType: 'app-service', sourceType: 'app-service-api-definition', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'baseline' },
  { id: 'discover-many', providerType: 'apim', sourceType: 'discover-many', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'baseline' },
  { id: 'iac-single', providerType: 'iac-local', sourceType: 'iac-embedded', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'baseline' },
  { id: 'ambiguity', providerType: '', sourceType: 'manual-review', specFormat: '', contractClass: 'association-only', lane: 'baseline' },

  // APIM multi-API clean repository / association
  { id: 'apim-clean-repo-tag', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'association-only', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-clean-repo-fox-pair', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'association-only', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  {
    id: 'apim-gateway-host-path',
    providerType: 'apim',
    sourceType: 'apim-export',
    specFormat: 'openapi-json',
    contractClass: 'association-only',
    lane: 'apim-clean-repo',
    requires: ['apim-multi'],
    claimFacets: Object.freeze(['association.gateway-hostname-hint', 'association.clean-repo-host-path'])
  },
  { id: 'apim-host-only-ambiguity', providerType: 'apim', sourceType: 'manual-review', specFormat: '', contractClass: 'association-only', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-version-revision-ambiguity', providerType: 'apim', sourceType: 'manual-review', specFormat: '', contractClass: 'association-only', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-explicit-historical-revision', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-version-set', providerType: 'apim', sourceType: 'apim-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'apim-clean-repo', requires: ['apim-multi'] },
  { id: 'apim-soap-wsdl', providerType: 'apim', sourceType: 'apim-export', specFormat: 'wsdl', contractClass: 'authoritative', lane: 'apim-formats', requires: ['apim-soap'] },
  { id: 'apim-graphql-sdl', providerType: 'apim', sourceType: 'apim-export', specFormat: 'graphql-sdl', contractClass: 'authoritative', lane: 'apim-formats', requires: ['apim-graphql'] },
  { id: 'apim-unsupported-websocket', providerType: 'apim', sourceType: 'manual-review', specFormat: '', contractClass: 'unsupported', lane: 'apim-unsupported', requires: ['apim-websocket'] },
  { id: 'apim-unsupported-grpc', providerType: 'apim', sourceType: 'manual-review', specFormat: '', contractClass: 'unsupported', lane: 'apim-unsupported', requires: ['apim-grpc'] },
  { id: 'apim-unsupported-odata', providerType: 'apim', sourceType: 'manual-review', specFormat: '', contractClass: 'unsupported', lane: 'apim-unsupported', requires: ['apim-odata'] },

  // API Center (eastus)
  { id: 'api-center-openapi-export', providerType: 'api-center', sourceType: 'api-center-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'api-center', requires: ['api-center'] },
  { id: 'api-center-native-non-openapi', providerType: 'api-center', sourceType: 'api-center-export', specFormat: 'graphql-sdl', contractClass: 'authoritative', lane: 'api-center', requires: ['api-center'] },
  { id: 'api-center-exact-binding', providerType: 'api-center', sourceType: 'api-center-export', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'api-center', requires: ['api-center'] },
  { id: 'api-center-ambiguity', providerType: 'api-center', sourceType: 'manual-review', specFormat: '', contractClass: 'association-only', lane: 'api-center', requires: ['api-center'] },

  // Logic Apps / custom connector / template specs
  { id: 'logic-apps-list-swagger', providerType: 'logic-apps', sourceType: 'logic-apps-workflow', specFormat: 'openapi-json', contractClass: 'reconstructed', lane: 'logic-apps', requires: ['logic-app'] },
  { id: 'logic-apps-reader-synthesis', providerType: 'logic-apps', sourceType: 'logic-apps-workflow', specFormat: 'openapi-json', contractClass: 'partial', lane: 'logic-apps', requires: ['logic-app'] },
  { id: 'custom-apis-inline-swagger', providerType: 'custom-apis', sourceType: 'custom-api-swagger', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'custom-apis', requires: ['custom-connector'] },
  { id: 'template-specs-embedded-apim', providerType: 'template-specs', sourceType: 'template-spec-embedded', specFormat: 'openapi-json', contractClass: 'partial', lane: 'template-specs', requires: ['template-spec'] },

  // Partial contracts
  { id: 'event-grid-webhook-partial', providerType: 'event-grid', sourceType: 'event-grid-webhook', specFormat: 'openapi-json', contractClass: 'partial', lane: 'event-grid', requires: ['event-grid'] },
  { id: 'service-bus-topic-partial', providerType: 'service-bus', sourceType: 'service-bus-topic', specFormat: 'openapi-json', contractClass: 'partial', lane: 'service-bus', requires: ['service-bus-standard'] },

  // Functions / App Service runtime-declared
  { id: 'function-bindings-openapi-extension', providerType: 'function-bindings', sourceType: 'function-bindings-trigger', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'functions', requires: ['function-app'] },
  { id: 'app-service-apispecpath-runtime', providerType: 'app-service', sourceType: 'app-service-api-definition', specFormat: 'openapi-json', contractClass: 'authoritative', lane: 'app-service-runtime', requires: ['app-service'] },

  // Local-only R3 (compiled CLI, no Azure)
  { id: 'local-r3-format-parser-matrix', providerType: 'repo', sourceType: 'repo-spec', specFormat: 'openapi-yaml', contractClass: 'authoritative', lane: 'local-r3', localOnly: true }
]);

export const PROVISION_FLAGS = Object.freeze({
  'apim-core': true,
  'apim-multi': true,
  'apim-soap': true,
  'apim-graphql': true,
  'apim-websocket': true,
  'apim-grpc': true,
  'apim-odata': true,
  'app-service': true,
  'api-center': true,
  'logic-app': true,
  'custom-connector': true,
  'template-spec': true,
  'event-grid': true,
  'service-bus-standard': false, // opt-in; cost-bounded Standard only when explicitly enabled
  'function-app': true
});

/** Reverse-dependency cleanup order for shared-group resource deletes. */
export const CLEANUP_RESOURCE_ORDER = Object.freeze([
  { key: 'eventGridSubName', type: 'Microsoft.EventGrid/topics/eventSubscriptions', nested: true, parentKey: 'eventGridTopicName', parentType: 'Microsoft.EventGrid/topics' },
  { key: 'eventGridTopicName', type: 'Microsoft.EventGrid/topics' },
  { key: 'serviceBusSubName', type: 'Microsoft.ServiceBus/namespaces/topics/subscriptions', nested: true, parentKey: 'serviceBusNamespaceName', parentType: 'Microsoft.ServiceBus/namespaces' },
  { key: 'serviceBusTopicName', type: 'Microsoft.ServiceBus/namespaces/topics', nested: true, parentKey: 'serviceBusNamespaceName', parentType: 'Microsoft.ServiceBus/namespaces' },
  { key: 'serviceBusNamespaceName', type: 'Microsoft.ServiceBus/namespaces' },
  { key: 'apiCenterServiceName', type: 'Microsoft.ApiCenter/services' },
  { key: 'functionAppName', type: 'Microsoft.Web/sites' },
  { key: 'customConnectorName', type: 'Microsoft.Web/customApis' },
  { key: 'logicAppName', type: 'Microsoft.Logic/workflows' },
  { key: 'templateSpecName', type: 'Microsoft.Resources/templateSpecs' },
  { key: 'siteName', type: 'Microsoft.Web/sites' },
  { key: 'planName', type: 'Microsoft.Web/serverfarms' },
  { key: 'apimName', type: 'Microsoft.ApiManagement/service' }
]);

export const SANITIZED_REASON_CODES = Object.freeze([
  'cli-failed',
  'unexpected-status',
  'unexpected-source-type',
  'provider-not-registered',
  'rbac-insufficient',
  'sku-unsupported',
  'region-unsupported',
  'cost-guard-blocked',
  'inventory-rejected',
  'export-unsupported',
  'capability-absent',
  'teardown-refused',
  'residue-detected',
  'local-only-matrix',
  'dry-run-skipped'
]);

/**
 * Classify an export-probe failure. Only states that self-heal after a
 * Succeeded deployment are retryable.
 */
export function classifyProbeError(message) {
  const text = String(message ?? '');
  if (/\b(401|403)\b|AuthorizationFailed|InvalidAuthenticationToken|Unauthorized|Forbidden/i.test(text)) {
    return 'fatal';
  }
  if (/\b400\b|BadRequest|InvalidParameters|ValidationError/i.test(text)) {
    return 'fatal';
  }
  return 'retryable';
}

export function isResourceNotFoundError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ResourceNotFound|could not be found|was not found|NotFound|\bNot Found\b/i.test(message);
}

export function parseFlags(argv) {
  return {
    provision: argv.includes('--provision'),
    teardown: argv.includes('--teardown'),
    dryRun: argv.includes('--dry-run'),
    renderPlan: argv.includes('--render-plan'),
    cancelRecover: argv.includes('--cancel-recover'),
    keepAlive: argv.includes('--keep-alive')
  };
}

export function parseProvisionFlags(env = process.env) {
  const raw = String(env.AZURE_LIVE_PROVISION_FLAGS ?? '').trim();
  const flags = { ...PROVISION_FLAGS };
  if (!raw) return flags;
  for (const token of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
    const disabled = token.startsWith('!');
    const key = disabled ? token.slice(1) : token.replace(/^\+/, '');
    if (!(key in flags)) {
      throw new Error(`Unknown provision flag ${JSON.stringify(key)}; expected one of ${Object.keys(PROVISION_FLAGS).join(', ')}`);
    }
    flags[key] = !disabled;
  }
  return flags;
}

export function requiredEnv(env) {
  const subscriptionId = String(env.AZURE_SUBSCRIPTION_ID ?? '').trim();
  const location = String(env.AZURE_LOCATION ?? '').trim();
  const resourceGroup = String(env.AZURE_RESOURCE_GROUP ?? '').trim();
  if (!subscriptionId) {
    throw new Error(
      'AZURE_SUBSCRIPTION_ID is required (set it explicitly, or authenticate az so `az account show` returns the azure-cse-pilot-builders subscription)'
    );
  }
  if (!location) throw new Error('AZURE_LOCATION is required');
  return { subscriptionId, location, resourceGroup };
}

export function shouldDeleteGroup({ manifest, groupShow, subscriptionId }) {
  if (!manifest?.resourceGroup || !manifest?.runMarker) return false;
  if (!groupShow) return false;
  if (groupShow.name !== manifest.resourceGroup) return false;
  const groupSubscription = String(groupShow.id ?? '').split('/')[2] ?? '';
  if (groupSubscription !== subscriptionId) return false;
  const marker = groupShow.tags?.[RUN_MARKER_TAG];
  return marker === manifest.runMarker;
}

export function shouldDeleteResource({ manifest, resourceShow, subscriptionId, expectedName, expectedType }) {
  if (!hasExactResourceIdentity({ manifest, resourceShow, subscriptionId, expectedName, expectedType })) return false;
  return resourceShow.tags?.[RESOURCE_RUN_MARKER_TAG] === manifest.runMarker;
}

/** Verify an ARM resource is exactly the run's expected object, without trusting tags. */
export function hasExactResourceIdentity({ manifest, resourceShow, subscriptionId, expectedName, expectedType }) {
  if (!manifest?.resourceGroup || !resourceShow?.id) return false;
  if (resourceShow.name !== expectedName || resourceShow.type?.toLowerCase() !== expectedType.toLowerCase()) return false;
  const expectedPrefix = `/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}/providers/`.toLowerCase();
  if (!String(resourceShow.id).toLowerCase().startsWith(expectedPrefix)) return false;
  return true;
}

/** Short commit correlation hash only — never raw pipeline/run IDs. */
export function resolveCommitHashPrefix(env = process.env, runner = defaultRunner) {
  const fromEnv = String(env.AZURE_LIVE_COMMIT_PREFIX ?? env.BUILD_SOURCEVERSION ?? env.GITHUB_SHA ?? '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv.slice(0, 7).toLowerCase();
  try {
    const sha = String(runner('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }) ?? '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 7).toLowerCase();
  } catch {
    // ignore
  }
  return '';
}

export function sanitizeReasonCode(code) {
  const value = String(code ?? '').trim();
  if (!value) return undefined;
  if (SANITIZED_REASON_CODES.includes(value)) return value;
  return 'capability-absent';
}

export function toEvidenceResult(id, status, fields = {}) {
  const catalog = CASE_CATALOG.find((row) => row.id === id);
  const result = {
    id,
    name: id,
    status,
    providerType: fields.providerType ?? catalog?.providerType ?? '',
    sourceType: fields.sourceType ?? catalog?.sourceType ?? '',
    specFormat: fields.specFormat ?? catalog?.specFormat ?? '',
    contractClass: fields.contractClass ?? catalog?.contractClass ?? ''
  };
  const reasonCode = sanitizeReasonCode(fields.reasonCode);
  if (reasonCode) result.reasonCode = reasonCode;
  if (typeof fields.durationMs === 'number' && Number.isFinite(fields.durationMs)) {
    result.durationMs = Math.max(0, Math.round(fields.durationMs));
  }
  return result;
}

export function buildEvidence(results, { suiteVersion = SUITE_VERSION, testedCommitHashPrefix = '', phases } = {}) {
  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail').length;
  const requiresCapability = results.filter((result) => result.status === 'requires-capability').length;
  const localOnly = results.filter((result) => result.status === 'local-only').length;
  const evidence = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    suiteVersion,
    testedCommitHashPrefix: testedCommitHashPrefix || undefined,
    capturedAt: new Date().toISOString().slice(0, 10),
    cases: results.length,
    passed,
    failed,
    requiresCapability,
    localOnly,
    results
  };
  if (Array.isArray(phases) && phases.length > 0) {
    evidence.phases = phases.map((phase) => ({
      name: String(phase?.name ?? ''),
      durationMs: Math.max(0, Math.round(Number(phase?.durationMs) || 0))
    }));
  }
  return evidence;
}

/**
 * Bounded-concurrency pool that preserves input order in the results array
 * regardless of completion order.
 */
export async function mapPool(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Coverage helper: only `pass` backs validationState=live. */
export function passingLiveCaseIds(evidence) {
  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  return new Set(
    results
      .filter((row) => row && row.status === 'pass')
      .map((row) => (typeof row.name === 'string' && row.name ? row.name : row.id))
      .filter((name) => typeof name === 'string' && name.trim())
  );
}

export function renderExecutionPlan({ provisionFlags = PROVISION_FLAGS, flags = parseFlags([]) } = {}) {
  const cases = CASE_CATALOG.map((row) => {
    const missing = (row.requires ?? []).filter((key) => provisionFlags[key] === false);
    return {
      id: row.id,
      lane: row.lane,
      localOnly: Boolean(row.localOnly),
      requires: row.requires ?? [],
      blockedByFlags: missing,
      plannedStatus: row.localOnly
        ? 'local-only'
        : missing.length > 0
          ? 'requires-capability'
          : 'executable'
    };
  });
  const cleanup = CLEANUP_RESOURCE_ORDER.map((row) => ({ key: row.key, type: row.type }));
  return {
    suiteVersion: SUITE_VERSION,
    pipelineId: PIPELINE_ID,
    pipelineName: PIPELINE_NAME,
    apiCenterLocation: API_CENTER_LOCATION,
    flags,
    provisionFlags,
    caseCount: cases.length,
    cases,
    cleanupOrder: cleanup,
    notes: [
      'Immutable githubRef is enforced by pipeline 157; harness records only testedCommitHashPrefix or suiteVersion.',
      'requires-capability is not live proof (Azure category; not GCP substitute).',
      'Never auto-register providers or elevate RBAC.',
      'Never delete the shared resource group CSE-Azure-Team.',
      'No personal subscription path.'
    ]
  };
}

function az(runner, args, options = {}) {
  return runner('az', args, options);
}

function defaultRunner(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

/** Promisified execFile with stderr folded into Error.message (same shape as sync failures). */
export async function defaultAsyncRunner(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...options
    });
    return stdout;
  } catch (error) {
    const stderr = error?.stderr != null ? String(error.stderr) : '';
    const stdout = error?.stdout != null ? String(error.stdout) : '';
    const base = error instanceof Error ? error.message : String(error ?? 'command failed');
    throw new Error([base, stdout, stderr].filter(Boolean).join('\n'));
  }
}

function azJson(runner, args) {
  const stdout = az(runner, [...args, '-o', 'json']);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function azAsync(asyncRunner, args, options = {}) {
  return asyncRunner('az', args, options);
}

async function azJsonAsync(asyncRunner, args, options = {}) {
  const stdout = await azAsync(asyncRunner, [...args, '-o', 'json'], options);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

/**
 * Probe stub site /health until HTTP 200 or the bounded ceiling elapses.
 * Returns true on success; false on timeout (caller classifies capability).
 */
export async function waitForStubHealth({
  url,
  timeoutMs = STUB_HEALTH_TIMEOUT_MS,
  intervalMs = STUB_HEALTH_POLL_INTERVAL_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = delay,
  log = () => undefined
} = {}) {
  if (!url || typeof fetchImpl !== 'function') return false;
  const deadline = now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'manual' });
      if (response?.status === 200) {
        log(`Stub health gate passed after ${attempt} probe(s)`);
        return true;
      }
      log(`Stub health gate probe ${attempt}: HTTP ${response?.status ?? 'unknown'}`);
    } catch (error) {
      log(`Stub health gate probe ${attempt}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
    if (now() >= deadline) {
      log(`Stub health gate timed out after ${timeoutMs}ms`);
      return false;
    }
    await sleep(intervalMs);
  }
}

export function resolveSubscriptionId(env, runner) {
  const fromEnv = String(env.AZURE_SUBSCRIPTION_ID ?? '').trim();
  if (fromEnv) return fromEnv;
  const fromAccount = String(az(runner, ['account', 'show', '--query', 'id', '-o', 'tsv']) ?? '').trim();
  if (!fromAccount) {
    throw new Error(
      'AZURE_SUBSCRIPTION_ID is required (set it explicitly, or authenticate az so `az account show` returns the azure-cse-pilot-builders subscription)'
    );
  }
  return fromAccount;
}

function redactSecrets(text) {
  return String(text ?? '')
    .replace(/sig=[^&\s"']+/gi, 'sig=REDACTED')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer REDACTED')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[redacted-uuid]');
}

function runCli(runner, cliPath, args, cwd, options = {}) {
  const execOptions = { cwd };
  if (options.env) {
    execOptions.env = { ...process.env, ...options.env };
  }
  const stdout = runner(process.execPath, [cliPath, ...args], execOptions);
  return JSON.parse(stdout);
}

function capabilityReasonFromError(error) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (/MissingSubscriptionRegistration|provider.*not registered|Register the .* resource provider/i.test(text)) {
    return 'provider-not-registered';
  }
  if (/AuthorizationFailed|Forbidden|does not have authorization|RBAC/i.test(text)) {
    return 'rbac-insufficient';
  }
  if (/SkuNotSupported|InvalidSku|sku/i.test(text)) {
    return 'sku-unsupported';
  }
  if (/LocationNotAvailable|region|Location .* not available/i.test(text)) {
    return 'region-unsupported';
  }
  if (/BadRequest|ValidationError|InvalidApiType|apiType/i.test(text)) {
    return 'inventory-rejected';
  }
  return 'capability-absent';
}

async function seedIacSingle(workspace) {
  const fixtures = path.join(repoRoot, 'validation/fixtures/azure/iac-single');
  await cp(path.join(fixtures, 'azure.yaml'), path.join(workspace, 'azure.yaml'));
  await mkdir(path.join(workspace, 'infra'), { recursive: true });
  await cp(path.join(fixtures, 'main.json'), path.join(workspace, 'infra', 'main.json'));
}

async function seedAmbiguity(workspace) {
  const spec = (name) =>
    JSON.stringify({
      $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
      contentVersion: '1.0.0.0',
      resources: [
        {
          type: 'Microsoft.ApiManagement/service/apis',
          apiVersion: '2023-05-01-preview',
          name: `apim-live/${name}`,
          properties: {
            displayName: name,
            path: name,
            protocols: ['https'],
            format: 'openapi+json',
            value: JSON.stringify({
              openapi: '3.0.3',
              info: { title: name, version: '1.0.0' },
              paths: { '/items': { get: { responses: { 200: { description: 'ok' } } } } }
            })
          }
        }
      ]
    });
  await mkdir(path.join(workspace, 'infra'), { recursive: true });
  await writeFile(path.join(workspace, 'infra', 'alpha.json'), spec('payments-alpha'), 'utf8');
  await writeFile(path.join(workspace, 'infra', 'bravo.json'), spec('payments-bravo'), 'utf8');
}

async function seedCleanRepoGateway(workspace, { gatewayHostname, apiPath, hostOnly = false }) {
  const lines = hostOnly
    ? [`Gateway host: https://${gatewayHostname}/`]
    : [`Gateway: https://${gatewayHostname}/${apiPath}`];
  await writeFile(path.join(workspace, 'README.md'), `${lines.join('\n')}\n`, 'utf8');
}

/** Canonical clean-repo fixture: path-selects payments-live; repo slug comes from env, not CLI. */
async function seedCanonicalCleanRepo(workspace, { gatewayHostname }) {
  await seedCleanRepoGateway(workspace, { gatewayHostname, apiPath: 'payments-live' });
  await writeFile(
    path.join(workspace, '.postman-clean-repo-canonical.md'),
    'canonical postman:repo association fixture; selection requires exact gateway host+path\n',
    'utf8'
  );
}

/** Fox clean-repo fixture: path-selects orders-live; distinct from canonical path evidence. */
async function seedFoxCleanRepo(workspace, { gatewayHostname }) {
  await seedCleanRepoGateway(workspace, { gatewayHostname, apiPath: 'orders-live' });
  await writeFile(
    path.join(workspace, '.postman-clean-repo-fox.md'),
    'Fox GithubOrg/GithubRepo association fixture; selection requires exact gateway host+path\n',
    'utf8'
  );
}

function cleanRepoEnv(manifest) {
  return {
    GITHUB_REPOSITORY: manifest.repoSlug,
    GITHUB_REPOSITORY_OWNER: String(manifest.repoSlug).split('/')[0] ?? ''
  };
}

async function seedLocalR3(workspace) {
  const source = path.join(repoRoot, 'validation/fixtures/azure/local-r3/specs');
  await mkdir(path.join(workspace, 'specs'), { recursive: true });
  for (const file of [
    'openapi.yaml',
    'asyncapi.yaml',
    'schema.graphql',
    'service.wsdl',
    'service.wadl',
    'types.xsd',
    'service.proto'
  ]) {
    await cp(path.join(source, file), path.join(workspace, 'specs', file));
  }
}

function expectResolved(result, expectedSource) {
  const resolution = result.resolution;
  if (!resolution || resolution.status !== 'resolved') {
    const diagnostic = resolution
      ? {
          status: resolution.status,
          confidence: resolution.confidence,
          narrowing: resolution.narrowing,
          evidence: Array.isArray(resolution.evidence) ? resolution.evidence.slice(0, 8) : [],
          rankedCandidates: Array.isArray(resolution.rankedCandidates)
            ? resolution.rankedCandidates.slice(0, 8).map((candidate) => ({
                serviceName: candidate.serviceName,
                providerType: candidate.providerType,
                confidence: candidate.confidence,
                supported: candidate.supported
              }))
            : []
        }
      : { status: 'missing' };
    throw new Error(`expected resolved, got ${resolution?.status ?? 'missing'}: ${redactSecrets(JSON.stringify(diagnostic))}`);
  }
  if (resolution.sourceType !== expectedSource) {
    throw new Error(`expected sourceType ${expectedSource}, got ${resolution.sourceType}`);
  }
  if (resolution.specPath && path.isAbsolute(resolution.specPath)) {
    throw new Error('spec path must be repo-relative');
  }
  return resolution;
}

function expectUnresolved(result) {
  const resolution = result.resolution;
  if (!resolution || resolution.status !== 'unresolved') {
    throw new Error(`expected unresolved, got ${resolution?.status ?? 'missing'}`);
  }
  if ((resolution.rankedCandidates?.length ?? 0) < 2) {
    throw new Error('expected at least two ranked candidates');
  }
  return resolution;
}

/**
 * Central catalog-backed assertion for a harness case pass.
 * Case-specific checks may pass `assert` to require exact API/revision/evidence.
 */
export function assertExpectedResult(caseId, resolution, options = {}) {
  const catalog = CASE_CATALOG.find((row) => row.id === caseId);
  if (!catalog) {
    throw new Error(`unknown catalog case ${caseId}`);
  }
  if (!resolution || typeof resolution !== 'object') {
    throw new Error(`case ${caseId}: missing resolution`);
  }

  if (catalog.sourceType === 'manual-review') {
    if (resolution.status !== 'unresolved' && resolution.status !== undefined) {
      // Dry-run/local stubs may omit status; live unresolved paths set it.
      if (resolution.sourceType && resolution.sourceType !== 'manual-review') {
        throw new Error(`case ${caseId}: expected manual-review unresolved, got ${resolution.sourceType}`);
      }
    }
    if (resolution.sourceType && resolution.sourceType !== catalog.sourceType) {
      throw new Error(`case ${caseId}: expected sourceType ${catalog.sourceType}, got ${resolution.sourceType}`);
    }
    if (catalog.providerType && resolution.providerType && resolution.providerType !== catalog.providerType) {
      throw new Error(
        `case ${caseId}: expected providerType ${catalog.providerType}, got ${resolution.providerType}`
      );
    }
  } else {
    if (resolution.sourceType !== catalog.sourceType) {
      throw new Error(`case ${caseId}: expected sourceType ${catalog.sourceType}, got ${resolution.sourceType}`);
    }
    if (catalog.providerType && resolution.providerType !== catalog.providerType) {
      throw new Error(
        `case ${caseId}: expected providerType ${catalog.providerType}, got ${resolution.providerType}`
      );
    }
    if (catalog.specFormat && resolution.specFormat !== catalog.specFormat) {
      throw new Error(`case ${caseId}: expected specFormat ${catalog.specFormat}, got ${resolution.specFormat}`);
    }
  }

  if (typeof options.expectedApiIdSuffix === 'string' && options.expectedApiIdSuffix) {
    const apiId = String(resolution.apiId ?? '');
    if (!apiId.toLowerCase().endsWith(options.expectedApiIdSuffix.toLowerCase())) {
      throw new Error(`case ${caseId}: expected apiId ending ${options.expectedApiIdSuffix}, got ${apiId || 'empty'}`);
    }
  }
  if (typeof options.forbiddenApiIdPattern === 'string' && options.forbiddenApiIdPattern) {
    if (new RegExp(options.forbiddenApiIdPattern, 'i').test(String(resolution.apiId ?? ''))) {
      throw new Error(`case ${caseId}: apiId matched forbidden pattern ${options.forbiddenApiIdPattern}`);
    }
  }
  if (typeof options.requiredEvidence === 'string' && options.requiredEvidence) {
    const evidence = Array.isArray(resolution.evidence) ? resolution.evidence.join('\n') : String(resolution.evidence ?? '');
    if (!new RegExp(options.requiredEvidence, 'i').test(evidence)) {
      throw new Error(`case ${caseId}: missing required evidence /${options.requiredEvidence}/`);
    }
  }
  if (typeof options.forbiddenEvidence === 'string' && options.forbiddenEvidence) {
    const evidence = Array.isArray(resolution.evidence) ? resolution.evidence.join('\n') : String(resolution.evidence ?? '');
    if (new RegExp(options.forbiddenEvidence, 'i').test(evidence)) {
      throw new Error(`case ${caseId}: found forbidden evidence /${options.forbiddenEvidence}/`);
    }
  }
  if (typeof options.expectedContractClass === 'string' && options.expectedContractClass) {
    if (resolution.contractClass !== options.expectedContractClass) {
      throw new Error(
        `case ${caseId}: expected contractClass ${options.expectedContractClass}, got ${resolution.contractClass}`
      );
    }
  }
  if (typeof options.assert === 'function') {
    options.assert(resolution, catalog);
  }

  return {
    sourceType: resolution.sourceType ?? catalog.sourceType,
    providerType: resolution.providerType ?? catalog.providerType,
    specFormat: resolution.specFormat ?? catalog.specFormat,
    contractClass: catalog.contractClass,
    apiId: resolution.apiId,
    evidence: resolution.evidence
  };
}

function evidenceText(resolution) {
  return Array.isArray(resolution?.evidence) ? resolution.evidence.join('\n') : String(resolution?.evidence ?? '');
}

function isPartialFallback(resolution) {
  if (resolution?.contractClass === 'partial') return true;
  return /Synthesized partial/i.test(evidenceText(resolution));
}

export function buildManifestNames({ suffix, runMarker, subscriptionId, resourceGroup, ownsResourceGroup, provisionFlags }) {
  return {
    resourceGroup,
    runMarker,
    subscriptionId,
    ownsResourceGroup,
    deploymentName: `postman-azure-spec-live-${suffix}`,
    extendedDeploymentName: `postman-azure-spec-ext-${suffix}`,
    apimName: `pmspecapim${suffix}`,
    planName: `pmspecplan${suffix}`,
    siteName: `pmspecsite${suffix}`,
    logicAppName: `pmspeclogic${suffix}`,
    customConnectorName: `pmspecconn${suffix}`,
    templateSpecName: `pmspectpl${suffix}`,
    eventGridTopicName: `pmspeceg${suffix}`,
    eventGridSubName: `pmspecegsub${suffix}`,
    apiCenterServiceName: `pmspecapic${suffix}`,
    functionAppName: `pmspecfn${suffix}`,
    serviceBusNamespaceName: `pmspecsb${suffix}`,
    serviceBusTopicName: 'payments-live',
    serviceBusSubName: 'payments-live-sub',
    repoSlug: 'postman-cs/postman-azure-spec-discovery-action',
    provisionFlags,
    resources: []
  };
}

export function recordManifestResource(manifest, entry) {
  manifest.resources.push({
    type: entry.type,
    name: entry.name,
    id: entry.id ?? null
  });
}

async function putApimApi(runner, { subscriptionId, resourceGroup, apimName, apiName, body }) {
  const url =
    `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.ApiManagement/service/${apimName}/apis/${encodeURIComponent(apiName)}?api-version=2024-05-01`;
  await Promise.resolve(az(runner, ['rest', '--method', 'put', '--url', url, '--body', JSON.stringify(body)]));
}

export async function provisionOptionalApimApis({
  runner,
  log,
  manifest,
  subscriptionId,
  provisionFlags,
  capabilities
}) {
  const { resourceGroup, apimName } = manifest;
  const soapWsdl = await readFile(path.join(repoRoot, 'validation/fixtures/azure/apim-apis/soap.wsdl'), 'utf8');
  const graphqlSdl = await readFile(path.join(repoRoot, 'validation/fixtures/azure/apim-apis/schema.graphql'), 'utf8');

  const optional = [
    {
      flag: 'apim-soap',
      apiName: 'payments-soap',
      body: {
        properties: {
          displayName: 'Payments SOAP API',
          path: 'payments-soap',
          protocols: ['https'],
          apiType: 'soap',
          format: 'wsdl',
          value: soapWsdl
        }
      }
    },
    {
      flag: 'apim-graphql',
      apiName: 'payments-graphql',
      body: {
        properties: {
          displayName: 'Payments GraphQL API',
          path: 'payments-graphql',
          protocols: ['https'],
          apiType: 'graphql'
        }
      },
      afterCreate: async () => {
        const schemaUrl =
          `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
          `/providers/Microsoft.ApiManagement/service/${apimName}/apis/payments-graphql/schemas/graphql?api-version=2024-05-01`;
        await Promise.resolve(
          az(runner, [
            'rest',
            '--method',
            'put',
            '--url',
            schemaUrl,
            '--body',
            JSON.stringify({
              properties: {
                contentType: 'application/vnd.ms-azure-apim.graphql.schema',
                document: { value: graphqlSdl }
              }
            })
          ])
        );
      }
    },
    {
      flag: 'apim-websocket',
      apiName: 'payments-websocket',
      body: {
        properties: {
          displayName: 'Payments WebSocket API',
          path: 'payments-websocket',
          protocols: ['wss'],
          apiType: 'websocket'
        }
      }
    },
    {
      flag: 'apim-grpc',
      apiName: 'payments-grpc',
      body: {
        properties: {
          displayName: 'Payments gRPC API',
          path: 'payments-grpc',
          protocols: ['https'],
          apiType: 'grpc'
        }
      }
    },
    {
      flag: 'apim-odata',
      apiName: 'payments-odata',
      body: {
        properties: {
          displayName: 'Payments OData API',
          path: 'payments-odata',
          protocols: ['https'],
          apiType: 'odata',
          serviceUrl: 'https://example.invalid/odata'
        }
      }
    }
  ];

  for (const item of optional) {
    if (!provisionFlags[item.flag]) {
      capabilities[item.flag] = { ok: false, reasonCode: 'cost-guard-blocked' };
      continue;
    }
    try {
      await putApimApi(runner, {
        subscriptionId,
        resourceGroup,
        apimName,
        apiName: item.apiName,
        body: item.body
      });
      if (item.afterCreate) await item.afterCreate();
      capabilities[item.flag] = { ok: true };
      recordManifestResource(manifest, {
        type: 'Microsoft.ApiManagement/service/apis',
        name: `${apimName}/${item.apiName}`
      });
      log(`Provisioned optional APIM API lane ${item.flag}`);
    } catch (error) {
      const reasonCode = capabilityReasonFromError(error);
      capabilities[item.flag] = { ok: false, reasonCode };
      log(`Optional APIM lane ${item.flag} unavailable (${reasonCode}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
  }
}

export async function provisionCustomConnectorBounded({
  asyncRunner,
  log,
  manifest,
  subscriptionId,
  location,
  provisionFlags,
  capabilities,
  siteHostname
}) {
  if (!provisionFlags['custom-connector']) {
    capabilities['custom-connector'] = { ok: false, reasonCode: 'cost-guard-blocked' };
    return;
  }

  try {
    const existing = await azJsonAsync(
      asyncRunner,
      [
        'resource',
        'show',
        '--resource-group',
        manifest.resourceGroup,
        '--resource-type',
        'Microsoft.Web/customApis',
        '--name',
        manifest.customConnectorName
      ],
      { timeout: CUSTOM_CONNECTOR_TIMEOUT_MS }
    );
    if (existing?.tags?.[RESOURCE_RUN_MARKER_TAG] === manifest.runMarker) {
      capabilities['custom-connector'] = { ok: true };
      recordManifestResource(manifest, { type: 'Microsoft.Web/customApis', name: manifest.customConnectorName });
      log('Persistent custom connector already provisioned');
      return;
    }
  } catch (error) {
    if (!isResourceNotFoundError(error)) {
      log(`Custom connector existence check failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
  }

  const url =
    `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}` +
    `/providers/Microsoft.Web/customApis/${manifest.customConnectorName}?api-version=2016-06-01`;
  const body = {
    location,
    tags: {
      [RESOURCE_RUN_MARKER_TAG]: manifest.runMarker,
      'postman:project-name': 'payments-connector'
    },
    properties: {
      displayName: 'Payments Live Connector',
      description: 'Inline swagger custom connector for live validation',
      swagger: {
        swagger: '2.0',
        info: { title: 'Payments Live Connector', version: '1.0.0' },
        host: siteHostname,
        basePath: '/',
        schemes: ['https'],
        paths: {
          '/health': {
            get: {
              operationId: 'GetHealth',
              responses: { 200: { description: 'ok' } }
            }
          }
        }
      }
    }
  };

  try {
    await azAsync(
      asyncRunner,
      ['rest', '--method', 'put', '--url', url, '--body', JSON.stringify(body)],
      { timeout: CUSTOM_CONNECTOR_TIMEOUT_MS }
    );
    capabilities['custom-connector'] = { ok: true };
    recordManifestResource(manifest, { type: 'Microsoft.Web/customApis', name: manifest.customConnectorName });
    log('Provisioned bounded custom connector lane');
  } catch (error) {
    const reasonCode = capabilityReasonFromError(error);
    capabilities['custom-connector'] = { ok: false, reasonCode };
    log(`Custom connector provision blocked (${reasonCode}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
}

async function preflightApiCenterProvider(runner, subscriptionId) {
  try {
    const stdout = await Promise.resolve(
      az(runner, [
        'provider',
        'show',
        '--namespace',
        'Microsoft.ApiCenter',
        '--subscription',
        subscriptionId,
        '-o',
        'json'
      ])
    );
    const providers = String(stdout ?? '').trim() ? JSON.parse(stdout) : null;
    const state = String(providers?.registrationState ?? '').toLowerCase();
    if (state !== 'registered') {
      return { ok: false, reasonCode: 'provider-not-registered' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reasonCode: capabilityReasonFromError(error) };
  }
}

async function provisionApiCenter({ runner, log, manifest, subscriptionId, capabilities }) {
  const preflight = await preflightApiCenterProvider(runner, subscriptionId);
  if (!preflight.ok) {
    capabilities['api-center'] = preflight;
    log(`API Center preflight blocked: ${preflight.reasonCode}`);
    return;
  }
  try {
    await Promise.resolve(
      az(runner, [
        'apic',
        'service',
        'create',
        '--name',
        manifest.apiCenterServiceName,
        '--resource-group',
        manifest.resourceGroup,
        '--location',
        API_CENTER_LOCATION,
        '--tags',
        `${RESOURCE_RUN_MARKER_TAG}=${manifest.runMarker}`
      ])
    );
    // Workspace / API / version / definitions (OpenAPI + GraphQL native).
    const base =
      `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}` +
      `/providers/Microsoft.ApiCenter/services/${manifest.apiCenterServiceName}`;
    await Promise.resolve(
      az(runner, [
        'rest',
        '--method',
        'put',
        '--url',
        `${base}/workspaces/default?api-version=2024-03-01`,
        '--body',
        JSON.stringify({ properties: { title: 'default' } })
      ])
    );
    await Promise.resolve(
      az(runner, [
        'rest',
        '--method',
        'put',
        '--url',
        `${base}/workspaces/default/apis/payments-apic?api-version=2024-03-01`,
        '--body',
        JSON.stringify({ properties: { title: 'Payments API Center', kind: 'rest' } })
      ])
    );
    await Promise.resolve(
      az(runner, [
        'rest',
        '--method',
        'put',
        '--url',
        `${base}/workspaces/default/apis/payments-apic/versions/v1?api-version=2024-03-01`,
        '--body',
        JSON.stringify({ properties: { title: 'v1', lifecycleStage: 'healthy' } })
      ])
    );
    const openapi = await readFile(path.join(repoRoot, 'validation/fixtures/azure/app-service-stub/openapi.json'), 'utf8');
    await Promise.resolve(
      az(runner, [
        'rest',
        '--method',
        'put',
        '--url',
        `${base}/workspaces/default/apis/payments-apic/versions/v1/definitions/openapi?api-version=2024-03-01`,
        '--body',
        JSON.stringify({
          properties: {
            title: 'openapi',
            specification: { name: 'openapi', version: '3.0.3' }
          }
        })
      ])
    );
    await Promise.resolve(
      az(runner, [
        'rest',
        '--method',
        'post',
        '--url',
        `${base}/workspaces/default/apis/payments-apic/versions/v1/definitions/openapi:importSpecification?api-version=2024-03-01`,
        '--body',
        JSON.stringify({ format: 'inline', value: openapi, specification: { name: 'openapi', version: '3.0.3' } })
      ])
    );
    const gql = await readFile(path.join(repoRoot, 'validation/fixtures/azure/apim-apis/schema.graphql'), 'utf8');
    await Promise.resolve(
      az(runner, [
        'rest',
        '--method',
        'put',
        '--url',
        `${base}/workspaces/default/apis/payments-apic/versions/v1/definitions/graphql?api-version=2024-03-01`,
        '--body',
        JSON.stringify({
          properties: {
            title: 'graphql',
            specification: { name: 'graphql', version: 'October2021' }
          }
        })
      ])
    );
    await Promise.resolve(
      az(runner, [
        'rest',
        '--method',
        'post',
        '--url',
        `${base}/workspaces/default/apis/payments-apic/versions/v1/definitions/graphql:importSpecification?api-version=2024-03-01`,
        '--body',
        JSON.stringify({ format: 'inline', value: gql, specification: { name: 'graphql', version: 'October2021' } })
      ])
    );
    capabilities['api-center'] = { ok: true };
    recordManifestResource(manifest, {
      type: 'Microsoft.ApiCenter/services',
      name: manifest.apiCenterServiceName
    });
    log(`Provisioned API Center service in ${API_CENTER_LOCATION}`);
  } catch (error) {
    const reasonCode = capabilityReasonFromError(error);
    capabilities['api-center'] = { ok: false, reasonCode };
    log(`API Center provision blocked (${reasonCode}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
}

async function provisionServiceBusIfGuarded({ runner, log, manifest, subscriptionId, provisionFlags, capabilities }) {
  if (!provisionFlags['service-bus-standard']) {
    capabilities['service-bus-standard'] = { ok: false, reasonCode: 'cost-guard-blocked' };
    log('Service Bus Standard lane disabled by cost guard (set AZURE_LIVE_PROVISION_FLAGS=service-bus-standard to opt in)');
    return;
  }
  try {
    await Promise.resolve(
      az(runner, [
        'servicebus',
        'namespace',
        'create',
        '--name',
        manifest.serviceBusNamespaceName,
        '--resource-group',
        manifest.resourceGroup,
        '--location',
        String(process.env.AZURE_LOCATION || 'eastus2'),
        '--sku',
        'Standard',
        '--tags',
        `${RESOURCE_RUN_MARKER_TAG}=${manifest.runMarker}`
      ])
    );
    await Promise.resolve(
      az(runner, [
        'servicebus',
        'topic',
        'create',
        '--namespace-name',
        manifest.serviceBusNamespaceName,
        '--resource-group',
        manifest.resourceGroup,
        '--name',
        manifest.serviceBusTopicName
      ])
    );
    await Promise.resolve(
      az(runner, [
        'servicebus',
        'topic',
        'subscription',
        'create',
        '--namespace-name',
        manifest.serviceBusNamespaceName,
        '--resource-group',
        manifest.resourceGroup,
        '--topic-name',
        manifest.serviceBusTopicName,
        '--name',
        manifest.serviceBusSubName
      ])
    );
    capabilities['service-bus-standard'] = { ok: true };
    recordManifestResource(manifest, {
      type: 'Microsoft.ServiceBus/namespaces',
      name: manifest.serviceBusNamespaceName
    });
    log('Provisioned run-owned Service Bus Standard namespace');
  } catch (error) {
    const reasonCode = capabilityReasonFromError(error);
    capabilities['service-bus-standard'] = { ok: false, reasonCode };
    log(`Service Bus provision blocked (${reasonCode}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
  void subscriptionId;
}

async function residualResourceGraphAudit({ runner, log, subscriptionId, runMarker }) {
  try {
    const query =
      `Resources | where tags['${RESOURCE_RUN_MARKER_TAG}'] == '${runMarker}' | project id, type, name, resourceGroup`;
    const rows =
      azJson(runner, [
        'graph',
        'query',
        '-q',
        query,
        '--subscriptions',
        subscriptionId
      ])?.data ?? [];
    if (Array.isArray(rows) && rows.length > 0) {
      log(`Resource Graph residual audit found ${rows.length} run-marked resource(s)`);
      return rows.length;
    }
    log('Resource Graph residual audit: zero run-marked resources');
    return 0;
  } catch (error) {
    log(`Resource Graph residual audit skipped/failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return -1;
  }
}

export async function teardownSharedGroupResources({
  runner,
  log,
  manifest,
  subscriptionId,
  now = () => Date.now(),
  sleep = delay
}) {
  const cleanupErrors = [];
  const resourceGroup = manifest.resourceGroup;
  const runMarker = manifest.runMarker;
  const deploymentNames = [manifest.extendedDeploymentName, manifest.deploymentName].filter(Boolean);

  const activeDeployments = new Set();
  for (const deploymentName of deploymentNames) {
    try {
      const deployment = azJson(runner, [
        'deployment',
        'group',
        'show',
        '--resource-group',
        resourceGroup,
        '--name',
        deploymentName
      ]);
      if (['Accepted', 'Running'].includes(deployment?.properties?.provisioningState)) {
        log(`Canceling active deployment ${deploymentName} before resource teardown`);
        az(runner, [
          'deployment',
          'group',
          'cancel',
          '--resource-group',
          resourceGroup,
          '--name',
          deploymentName
        ]);
        activeDeployments.add(deploymentName);
      }
    } catch (error) {
      if (!isResourceNotFoundError(error)) {
        cleanupErrors.push(error);
        log(`Deployment cancellation check failed for ${deploymentName}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }

  const deploymentCancelDeadline = now() + CLEANUP_READY_TIMEOUT_MS;
  while (activeDeployments.size > 0 && now() < deploymentCancelDeadline) {
    for (const deploymentName of [...activeDeployments]) {
      try {
        const deployment = azJson(runner, [
          'deployment',
          'group',
          'show',
          '--resource-group',
          resourceGroup,
          '--name',
          deploymentName
        ]);
        if (!['Accepted', 'Running'].includes(deployment?.properties?.provisioningState)) {
          activeDeployments.delete(deploymentName);
        }
      } catch (error) {
        if (isResourceNotFoundError(error)) activeDeployments.delete(deploymentName);
        else {
          cleanupErrors.push(error);
          activeDeployments.delete(deploymentName);
          log(`Deployment cancellation poll failed for ${deploymentName}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        }
      }
    }
    if (activeDeployments.size > 0) await sleep(CLEANUP_POLL_INTERVAL_MS);
  }
  if (activeDeployments.size > 0) {
    cleanupErrors.push(new Error(`${activeDeployments.size} deployment cancellation(s) did not reach a terminal state`));
  }

  for (const resource of CLEANUP_RESOURCE_ORDER) {
    const name = manifest[resource.key];
    if (!name) continue;
    try {
      if (resource.nested && resource.parentKey && resource.parentType && manifest[resource.parentKey]) {
        const nestedName =
          resource.key === 'eventGridSubName'
            ? `${manifest.eventGridTopicName}/${name}`
            : resource.key === 'serviceBusTopicName'
              ? `${manifest.serviceBusNamespaceName}/${name}`
              : `${manifest.serviceBusNamespaceName}/${manifest.serviceBusTopicName}/${name}`;
        const show = azJson(runner, [
          'resource',
          'show',
          '--resource-group',
          resourceGroup,
          '--resource-type',
          resource.type,
          '--name',
          nestedName
        ]);
        const parentName = manifest[resource.parentKey];
        const parent = azJson(runner, [
          'resource', 'show', '--resource-group', resourceGroup,
          '--resource-type', resource.parentType, '--name', parentName
        ]);
        if (
          hasExactResourceIdentity({ manifest, resourceShow: show, subscriptionId, expectedName: nestedName, expectedType: resource.type }) &&
          shouldDeleteResource({ manifest, resourceShow: parent, subscriptionId, expectedName: parentName, expectedType: resource.parentType })
        ) {
          // Child resources commonly have no tags; their exact ARM identity plus a
          // fully verified run-marked root parent is the deletion authority.
          log(`Deleting run-marked ${resource.type} ${nestedName}`);
          az(runner, ['resource', 'delete', '--ids', show.id, '--no-wait']);
        } else {
          log(`REFUSING nested deletion: identity or parent marker mismatch for ${nestedName}`);
        }
        continue;
      }

      const resourceShow = azJson(runner, [
        'resource',
        'show',
        '--resource-group',
        resourceGroup,
        '--resource-type',
        resource.type,
        '--name',
        name
      ]);
      if (
        shouldDeleteResource({
          manifest,
          resourceShow,
          subscriptionId,
          expectedName: name,
          expectedType: resource.type
        })
      ) {
        log(`Deleting run-marked ${resource.type} ${name} from shared group ${resourceGroup}`);
        az(runner, ['resource', 'delete', '--ids', resourceShow.id, '--no-wait']);
      } else {
        log(`REFUSING deletion: ${name} failed the run-marker/resource identity check.`);
      }
    } catch (error) {
      if (isResourceNotFoundError(error)) {
        log(`Run-marked ${resource.type} ${name} is already absent`);
      } else {
        cleanupErrors.push(error);
        log(`Teardown error for ${name}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }

  for (const deploymentName of deploymentNames) {
    try {
      az(runner, [
        'deployment',
        'group',
        'delete',
        '--resource-group',
        resourceGroup,
        '--name',
        deploymentName,
        '--no-wait'
      ]);
    } catch (error) {
      if (!isResourceNotFoundError(error)) {
        cleanupErrors.push(error);
        log(`Deployment-record cleanup error for ${deploymentName}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }

  const cleanupDeadline = now() + CLEANUP_READY_TIMEOUT_MS;
  let residual = [];
  for (;;) {
    const groupResources =
      azJson(runner, ['resource', 'list', '--resource-group', resourceGroup]) ?? [];
    residual = groupResources.filter((resource) => resource.tags?.[RESOURCE_RUN_MARKER_TAG] === runMarker);
    if (residual.length === 0 || now() >= cleanupDeadline) break;
    log(`Waiting for ${residual.length} run-marked resource deletion(s) to finish`);
    await sleep(CLEANUP_POLL_INTERVAL_MS);
  }
  if (residual.length > 0) {
    cleanupErrors.push(new Error(`${residual.length} run-marked resource(s) remain`));
  }

  const graphCount = await residualResourceGraphAudit({ runner, log, subscriptionId, runMarker });
  if (graphCount > 0) {
    cleanupErrors.push(new Error(`Resource Graph residual audit reported ${graphCount} resource(s)`));
  }

  if (cleanupErrors.length > 0) {
    throw new Error(`Shared-group teardown did not complete: ${cleanupErrors.length} cleanup check(s) failed`);
  }
}

/**
 * Await dedicated resource-group deletion to terminal absence, then audit residuals.
 * Timeout/failure must fail the run; messages stay redacted (no raw IDs in committed evidence).
 */
export async function teardownDedicatedResourceGroup({
  runner,
  log,
  manifest,
  subscriptionId,
  now = () => Date.now(),
  sleep = delay
}) {
  const resourceGroup = manifest.resourceGroup;
  const runMarker = manifest.runMarker;
  let groupShow = null;
  try {
    groupShow = azJson(runner, ['group', 'show', '--name', resourceGroup]);
  } catch (error) {
    if (isResourceNotFoundError(error)) {
      log(`Dedicated resource group already absent`);
      const graphCount = await residualResourceGraphAudit({ runner, log, subscriptionId, runMarker });
      if (graphCount > 0) {
        throw new Error('Dedicated-group teardown residual audit reported remaining run-marked resources');
      }
      return;
    }
    throw error;
  }

  if (!shouldDeleteGroup({ manifest, groupShow, subscriptionId })) {
    throw new Error('Dedicated-group teardown refused: run-marker/subscription check failed');
  }

  log(`Deleting run-marked dedicated resource group`);
  az(runner, ['group', 'delete', '--yes', '--name', resourceGroup]);

  const cleanupDeadline = now() + CLEANUP_READY_TIMEOUT_MS;
  for (;;) {
    try {
      azJson(runner, ['group', 'show', '--name', resourceGroup]);
    } catch (error) {
      if (isResourceNotFoundError(error)) {
        break;
      }
      throw error;
    }
    if (now() >= cleanupDeadline) {
      throw new Error('Dedicated-group teardown timed out before terminal absence');
    }
    log('Waiting for dedicated resource group deletion to finish');
    await sleep(CLEANUP_POLL_INTERVAL_MS);
  }

  try {
    azJson(runner, ['group', 'show', '--name', resourceGroup]);
    throw new Error('Dedicated-group teardown residue: group still present after delete');
  } catch (error) {
    if (!isResourceNotFoundError(error)) {
      throw error;
    }
  }

  const graphCount = await residualResourceGraphAudit({ runner, log, subscriptionId, runMarker });
  if (graphCount > 0) {
    throw new Error('Dedicated-group teardown residual audit reported remaining run-marked resources');
  }
  log('Dedicated-group teardown complete: group absent and residual audit clean');
}

async function runDefaultCases({
  runner,
  log,
  manifest,
  subscriptionId,
  cliPath,
  capabilities = {},
  now = () => Date.now(),
  caseConcurrency = CASE_MATRIX_CONCURRENCY,
  caseFilter = []
}) {
  const caseTasks = [];
  const armApiId =
    `/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}/providers/Microsoft.ApiManagement/service/${manifest.apimName}/apis/payments-live`;
  const historicalApiId = `${armApiId};rev=2`;
  const gatewayHostname = `${manifest.apimName}.azure-api.net`;

  function defineCase(id, fn, { allowRequiresCapability = false } = {}) {
    caseTasks.push({ id, fn, allowRequiresCapability });
  }

  async function executeCase({ id, fn, allowRequiresCapability = false }) {
    const started = now();
    const workspace = await mkdtemp(path.join(os.tmpdir(), `az-live-${id}-`));
    try {
      const resolution = await fn(workspace);
      const durationMs = now() - started;
      if (resolution?.__status === 'requires-capability') {
        log(`case ${id}: requires-capability (${resolution.reasonCode ?? 'capability-absent'})`);
        return toEvidenceResult(id, 'requires-capability', {
          reasonCode: resolution.reasonCode,
          providerType: resolution.providerType,
          sourceType: resolution.sourceType,
          specFormat: resolution.specFormat,
          contractClass: resolution.contractClass,
          durationMs
        });
      }
      if (resolution?.__status === 'local-only') {
        log(`case ${id}: local-only`);
        return toEvidenceResult(id, 'local-only', {
          reasonCode: 'local-only-matrix',
          providerType: resolution.providerType,
          sourceType: resolution.sourceType,
          specFormat: resolution.specFormat,
          durationMs
        });
      }
      const assertOptions = resolution?.__assertOptions ?? {};
      const resolutionFields = { ...resolution };
      delete resolutionFields.__assertOptions;
      delete resolutionFields.__status;
      const asserted = assertExpectedResult(id, resolutionFields, assertOptions);
      log(`case ${id}: pass`);
      return toEvidenceResult(id, 'pass', { ...asserted, durationMs });
    } catch (error) {
      const durationMs = now() - started;
      if (allowRequiresCapability) {
        log(`case ${id}: requires-capability (${capabilityReasonFromError(error)})`);
        return toEvidenceResult(id, 'requires-capability', {
          reasonCode: capabilityReasonFromError(error),
          durationMs
        });
      }
      log(`case ${id}: fail (${redactSecrets(error instanceof Error ? error.message : String(error))})`);
      return toEvidenceResult(id, 'fail', { reasonCode: 'cli-failed', durationMs });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  function capabilityGate(flag) {
    const state = capabilities[flag];
    if (state && state.ok === false) {
      return {
        __status: 'requires-capability',
        reasonCode: state.reasonCode ?? 'capability-absent'
      };
    }
    return null;
  }

  // --- Baseline six ---
  defineCase('apim-explicit-api-id', async (workspace) => {
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--api-id',
        armApiId,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    const resolution = expectResolved(result, 'apim-export');
    return {
      ...resolution,
      __assertOptions: { expectedApiIdSuffix: '/apis/payments-live', forbiddenApiIdPattern: ';rev=' }
    };
  });

  defineCase('apim-discovery', async (workspace) => {
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-live',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    const resolution = expectResolved(result, 'apim-export');
    return {
      ...resolution,
      __assertOptions: { expectedApiIdSuffix: '/apis/payments-live' }
    };
  });

  defineCase('app-service-api-definition', async (workspace) => {
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-live-site',
        '--api-filter',
        manifest.siteName,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'app-service-api-definition');
  });

  defineCase('discover-many', async (workspace) => {
    const result = runCli(
      runner,
      cliPath,
      [
        '--mode',
        'discover-many',
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    if (!Array.isArray(result.discovered) || result.discovered.length < 1) {
      throw new Error('discover-many exported no services');
    }
    if ((result.exportSummary?.failed ?? 1) !== 0) {
      throw new Error('discover-many reported export failures');
    }
    return {
      sourceType: 'discover-many',
      providerType: result.discovered[0]?.providerType ?? 'apim',
      specFormat: result.discovered[0]?.specFormat ?? 'openapi-json',
      contractClass: 'authoritative'
    };
  });

  defineCase('iac-single', async (workspace) => {
    await seedIacSingle(workspace);
    const result = runCli(
      runner,
      cliPath,
      [
        '--repo-root',
        workspace,
        '--preflight-checks',
        'false',
        '--subscription-id',
        subscriptionId,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'iac-embedded');
  });

  defineCase('ambiguity', async (workspace) => {
    await seedAmbiguity(workspace);
    const result = runCli(
      runner,
      cliPath,
      [
        '--repo-root',
        workspace,
        '--preflight-checks',
        'false',
        '--subscription-id',
        subscriptionId,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectUnresolved(result);
  });

  // --- APIM clean-repo / formats ---
  // No --api-id / --repo-slug: repository context comes from GITHUB_REPOSITORY.
  // Path fixtures isolate canonical vs Fox; inherited service tags alone do not select.
  defineCase('apim-clean-repo-tag', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    await seedCanonicalCleanRepo(workspace, { gatewayHostname });
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace,
      { env: cleanRepoEnv(manifest) }
    );
    const resolution = expectResolved(result, 'apim-export');
    return {
      ...resolution,
      __assertOptions: { expectedApiIdSuffix: '/apis/payments-live' }
    };
  });

  defineCase('apim-clean-repo-fox-pair', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    await seedFoxCleanRepo(workspace, { gatewayHostname });
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace,
      { env: cleanRepoEnv(manifest) }
    );
    const resolution = expectResolved(result, 'apim-export');
    return {
      ...resolution,
      __assertOptions: { expectedApiIdSuffix: '/apis/orders-live' }
    };
  });

  defineCase('apim-gateway-host-path', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    await seedCleanRepoGateway(workspace, { gatewayHostname, apiPath: 'payments-live' });
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace,
      { env: cleanRepoEnv(manifest) }
    );
    const resolution = expectResolved(result, 'apim-export');
    return {
      ...resolution,
      __assertOptions: { expectedApiIdSuffix: '/apis/payments-live' }
    };
  });

  defineCase('apim-host-only-ambiguity', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    await seedCleanRepoGateway(workspace, { gatewayHostname, apiPath: '', hostOnly: true });
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace,
      { env: cleanRepoEnv(manifest) }
    );
    // Inherited service tags across multiple APIs must remain unresolved without path evidence.
    return expectUnresolved(result);
  });

  defineCase('apim-version-revision-ambiguity', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    // Host-only + version selector with current+historical revisions must stay unresolved.
    await seedCleanRepoGateway(workspace, { gatewayHostname, apiPath: '', hostOnly: true });
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--api-version',
        'v1',
        '--result-json',
        'result.json'
      ],
      workspace,
      { env: cleanRepoEnv(manifest) }
    );
    return expectUnresolved(result);
  });

  defineCase('apim-explicit-historical-revision', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--api-id',
        historicalApiId,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    const resolution = expectResolved(result, 'apim-export');
    return {
      ...resolution,
      __assertOptions: { expectedApiIdSuffix: ';rev=2' }
    };
  });

  defineCase('apim-version-set', async (workspace) => {
    const gated = capabilityGate('apim-multi');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-live',
        '--api-version',
        'v1',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    const resolution = expectResolved(result, 'apim-export');
    return {
      ...resolution,
      __assertOptions: { expectedApiIdSuffix: '/apis/payments-live', forbiddenApiIdPattern: ';rev=2$' }
    };
  });

  defineCase('apim-soap-wsdl', async (workspace) => {
    const gated = capabilityGate('apim-soap');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'Payments SOAP API',
        '--api-filter',
        'payments-soap',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'apim-export');
  });

  defineCase('apim-graphql-sdl', async (workspace) => {
    const gated = capabilityGate('apim-graphql');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'Payments GraphQL API',
        '--api-filter',
        'payments-graphql',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'apim-export');
  });

  for (const unsupported of [
    { id: 'apim-unsupported-websocket', flag: 'apim-websocket', filter: 'payments-websocket' },
    { id: 'apim-unsupported-grpc', flag: 'apim-grpc', filter: 'payments-grpc' },
    { id: 'apim-unsupported-odata', flag: 'apim-odata', filter: 'payments-odata' }
  ]) {
    defineCase(unsupported.id, async (workspace) => {
      const gated = capabilityGate(unsupported.flag);
      if (gated) return gated;
      const result = runCli(
        runner,
        cliPath,
        [
          '--subscription-id',
          subscriptionId,
          '--resource-group',
          manifest.resourceGroup,
          '--api-filter',
          unsupported.filter,
          '--repo-root',
          workspace,
          '--result-json',
          'result.json'
        ],
        workspace
      );
      const resolution = result.resolution;
      if (!resolution || resolution.status !== 'unresolved' || resolution.sourceType !== 'manual-review') {
        throw new Error(`expected manual-review for ${unsupported.filter}, got ${resolution?.status}/${resolution?.sourceType}`);
      }
      return resolution;
    });
  }

  // --- API Center ---
  for (const apiCenterCase of [
    'api-center-openapi-export',
    'api-center-native-non-openapi',
    'api-center-exact-binding',
    'api-center-ambiguity'
  ]) {
    defineCase(apiCenterCase, async (workspace) => {
      const gated = capabilityGate('api-center');
      if (gated) {
        return {
          ...gated,
          reasonCode: gated.reasonCode,
          providerType: 'api-center'
        };
      }
      const definitionId =
        `/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}/providers/Microsoft.ApiCenter/services/${manifest.apiCenterServiceName}/workspaces/default/apis/payments-apic/versions/v1/definitions/${
          apiCenterCase === 'api-center-native-non-openapi' ? 'graphql' : 'openapi'
        }`;
      if (apiCenterCase === 'api-center-ambiguity') {
        const result = runCli(
          runner,
          cliPath,
          [
            '--subscription-id',
            subscriptionId,
            '--resource-group',
            manifest.resourceGroup,
            '--repo-root',
            workspace,
            '--result-json',
            'result.json'
          ],
          workspace
        );
        // Ambiguity across OpenAPI + GraphQL definitions should rank, not guess.
        if (result.resolution?.status === 'resolved') {
          throw new Error('expected ambiguity across API Center definitions');
        }
        return expectUnresolved(result);
      }
      const args = [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ];
      if (apiCenterCase === 'api-center-exact-binding' || apiCenterCase === 'api-center-openapi-export' || apiCenterCase === 'api-center-native-non-openapi') {
        args.push('--api-center-definition-id', definitionId);
      }
      const result = runCli(runner, cliPath, args, workspace);
      const resolution = expectResolved(result, 'api-center-export');
      if (apiCenterCase === 'api-center-native-non-openapi') {
        return {
          ...resolution,
          __assertOptions: {
            expectedContractClass: 'authoritative',
            assert: (resolved) => {
              if (resolved.specFormat !== 'graphql-sdl') {
                throw new Error(`api-center-native-non-openapi expected graphql-sdl, got ${resolved.specFormat}`);
              }
            }
          }
        };
      }
      return resolution;
    });
  }

  // --- Logic / connector / template / event-grid / service-bus / functions ---
  defineCase('logic-apps-list-swagger', async (workspace) => {
    const gated = capabilityGate('logic-app');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-logic',
        '--enable-logic-apps-list-swagger',
        'true',
        '--require-logic-apps-native-swagger',
        'true',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    if (result.resolution?.status !== 'resolved') {
      return { __status: 'requires-capability', reasonCode: 'capability-absent', providerType: 'logic-apps' };
    }
    const resolution = expectResolved(result, 'logic-apps-workflow');
    if (isPartialFallback(resolution) || !/native listSwagger/i.test(evidenceText(resolution))) {
      // Never accept Reader synthesis as proof of the native listSwagger case.
      return {
        __status: 'requires-capability',
        reasonCode: 'rbac-insufficient',
        providerType: 'logic-apps',
        sourceType: 'logic-apps-workflow',
        specFormat: 'openapi-json',
        contractClass: 'reconstructed'
      };
    }
    return {
      ...resolution,
      __assertOptions: { requiredEvidence: 'native listSwagger', forbiddenEvidence: 'Synthesized partial' }
    };
  });

  defineCase('logic-apps-reader-synthesis', async (workspace) => {
    const gated = capabilityGate('logic-app');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-logic',
        '--enable-logic-apps-list-swagger',
        'false',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    const resolution = expectResolved(result, 'logic-apps-workflow');
    return {
      ...resolution,
      __assertOptions: { expectedContractClass: 'partial' }
    };
  });

  defineCase('custom-apis-inline-swagger', async (workspace) => {
    const gated = capabilityGate('custom-connector');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-connector',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'custom-api-swagger');
  });

  defineCase('template-specs-embedded-apim', async (workspace) => {
    const gated = capabilityGate('template-spec');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-templatespec',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'template-spec-embedded');
  });

  defineCase('event-grid-webhook-partial', async (workspace) => {
    const gated = capabilityGate('event-grid');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-eventgrid',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'event-grid-webhook');
  });

  defineCase('service-bus-topic-partial', async (workspace) => {
    const gated = capabilityGate('service-bus-standard');
    if (gated) return gated;
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-live',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    return expectResolved(result, 'service-bus-topic');
  });

  defineCase('function-bindings-openapi-extension', async (workspace) => {
    const gated = capabilityGate('function-app');
    if (gated) return gated;
    if (!manifest.functionOpenApiExtensionSeeded) {
      return {
        __status: 'requires-capability',
        reasonCode: 'capability-absent',
        providerType: 'function-bindings',
        sourceType: 'function-bindings-trigger',
        specFormat: 'openapi-json',
        contractClass: 'authoritative'
      };
    }
    const result = runCli(
      runner,
      cliPath,
      [
        '--subscription-id',
        subscriptionId,
        '--resource-group',
        manifest.resourceGroup,
        '--expected-service-name',
        'payments-functions',
        '--enable-functions-openapi-extension',
        'true',
        '--repo-root',
        workspace,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    if (result.resolution?.status !== 'resolved') {
      return {
        __status: 'requires-capability',
        reasonCode: 'capability-absent',
        providerType: 'function-bindings'
      };
    }
    const resolution = expectResolved(result, 'function-bindings-trigger');
    if (isPartialFallback(resolution) || !/OpenAPI extension/i.test(evidenceText(resolution))) {
      return {
        __status: 'requires-capability',
        reasonCode: 'capability-absent',
        providerType: 'function-bindings',
        sourceType: 'function-bindings-trigger',
        specFormat: 'openapi-json',
        contractClass: 'authoritative'
      };
    }
    return {
      ...resolution,
      __assertOptions: {
        expectedContractClass: 'authoritative',
        requiredEvidence: 'OpenAPI extension',
        forbiddenEvidence: 'Synthesized partial'
      }
    };
  });

  defineCase('app-service-apispecpath-runtime', async (workspace) => {
    const gated = capabilityGate('app-service');
    if (gated) return gated;
    // Seed ApiSpecPath and clear public apiDefinition so the case cannot pass on URL fallback.
    const configUrl =
      `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${manifest.resourceGroup}` +
      `/providers/Microsoft.Web/sites/${manifest.siteName}/config/web?api-version=2023-12-01`;
    let seeded = false;
    try {
      az(runner, [
        'rest',
        '--method',
        'patch',
        '--url',
        configUrl,
        '--body',
        JSON.stringify({
          properties: {
            apiDefinition: { url: null },
            aiIntegration: { ApiSpecPath: '/home/site/wwwroot/openapi.json' }
          }
        })
      ]);
      seeded = true;
      manifest.appServiceApiSpecPathSeeded = true;
    } catch (error) {
      log(
        `ApiSpecPath seed blocked: ${redactSecrets(error instanceof Error ? error.message : String(error))}`
      );
    }
    if (!seeded) {
      return {
        __status: 'requires-capability',
        reasonCode: 'capability-absent',
        providerType: 'app-service',
        sourceType: 'app-service-api-definition',
        specFormat: 'openapi-json',
        contractClass: 'authoritative'
      };
    }
    try {
      const result = runCli(
        runner,
        cliPath,
        [
          '--subscription-id',
          subscriptionId,
          '--resource-group',
          manifest.resourceGroup,
          '--expected-service-name',
          'payments-live-site',
          '--api-filter',
          manifest.siteName,
          '--enable-app-service-scm-spec-fetch',
          'true',
          '--enable-runtime-declared-spec-routes',
          'true',
          '--repo-root',
          workspace,
          '--result-json',
          'result.json'
        ],
        workspace
      );
      if (result.resolution?.status !== 'resolved') {
        return {
          __status: 'requires-capability',
          reasonCode: 'capability-absent',
          providerType: 'app-service'
        };
      }
      const resolution = expectResolved(result, 'app-service-api-definition');
      if (!/ApiSpecPath|SCM\/VFS|site SCM/i.test(evidenceText(resolution))) {
        return {
          __status: 'requires-capability',
          reasonCode: 'capability-absent',
          providerType: 'app-service',
          sourceType: 'app-service-api-definition',
          specFormat: 'openapi-json',
          contractClass: 'authoritative'
        };
      }
      return {
        ...resolution,
        __assertOptions: {
          requiredEvidence: 'ApiSpecPath|SCM',
          forbiddenEvidence: 'declares an API definition URL'
        }
      };
    } finally {
      // Restore public apiDefinition for any later cases / operator inspection.
      try {
        const site = azJson(runner, [
          'webapp',
          'show',
          '--resource-group',
          manifest.resourceGroup,
          '--name',
          manifest.siteName
        ]);
        const stubUrl = `https://${site.defaultHostName}/openapi.json`;
        az(runner, [
          'rest',
          '--method',
          'patch',
          '--url',
          configUrl,
          '--body',
          JSON.stringify({ properties: { apiDefinition: { url: stubUrl } } })
        ]);
      } catch {
        // best-effort restore
      }
    }
  });

  defineCase('local-r3-format-parser-matrix', async (workspace) => {
    await seedLocalR3(workspace);
    const result = runCli(
      runner,
      cliPath,
      [
        '--repo-root',
        workspace,
        '--preflight-checks',
        'false',
        '--subscription-id',
        subscriptionId,
        '--result-json',
        'result.json'
      ],
      workspace
    );
    // Multiple native formats => ambiguity or single openapi resolve; either proves CLI parsing without Azure.
    if (result.resolution?.status === 'resolved' && result.resolution.sourceType === 'repo-spec') {
      return { __status: 'local-only', ...result.resolution };
    }
    if (result.resolution?.status === 'unresolved' && (result.resolution.rankedCandidates?.length ?? 0) >= 2) {
      return {
        __status: 'local-only',
        providerType: 'repo',
        sourceType: 'manual-review',
        specFormat: '',
        contractClass: 'authoritative'
      };
    }
    throw new Error('local R3 matrix did not exercise compiled CLI repo discovery');
  });

  const requested = new Set(caseFilter);
  const selected = requested.size > 0 ? caseTasks.filter((task) => requested.has(task.id)) : caseTasks;
  const missing = [...requested].filter((id) => !caseTasks.some((task) => task.id === id));
  if (missing.length > 0) {
    throw new Error(`Unknown AZURE_LIVE_CASE_FILTER case(s): ${missing.join(', ')}`);
  }
  return mapPool(selected, caseConcurrency, (task) => executeCase(task));
}

/**
 * Main control flow, dependency-injected for unit tests.
 */
export async function runLiveValidation({ argv = process.argv.slice(2), env = process.env, deps = {} } = {}) {
  const runner = deps.runner ?? defaultRunner;
  // Parallel groups use an async runner. When tests inject a sync runner, wrap it
  // so unit tests stay deterministic (no real child_process concurrency) unless
  // deps.asyncRunner is provided explicitly.
  const asyncRunner =
    deps.asyncRunner ??
    (deps.runner
      ? async (command, args, options) => runner(command, args, options)
      : defaultAsyncRunner);
  const log = deps.log ?? ((line) => console.error(line));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? delay;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const runCases = deps.runCases ?? runDefaultCases;
  const phases = [];

  const flags = parseFlags(argv);
  const provisionFlags = parseProvisionFlags(env);
  const caseFilter = String(env.AZURE_LIVE_CASE_FILTER ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const testedCommitHashPrefix = resolveCommitHashPrefix(env, runner);

  if (flags.dryRun || flags.renderPlan) {
    const plan = renderExecutionPlan({ provisionFlags, flags });
    const dryResults = CASE_CATALOG.map((row) => {
      if (row.localOnly) {
        return toEvidenceResult(row.id, 'local-only', { reasonCode: 'local-only-matrix' });
      }
      const missing = (row.requires ?? []).filter((key) => provisionFlags[key] === false);
      if (missing.length > 0) {
        return toEvidenceResult(row.id, 'requires-capability', { reasonCode: 'cost-guard-blocked' });
      }
      return toEvidenceResult(row.id, 'requires-capability', { reasonCode: 'dry-run-skipped' });
    });
    const evidence = buildEvidence(dryResults, { testedCommitHashPrefix });
    await mkdir(path.join(repoRoot, 'validation/evidence'), { recursive: true });
    await writeFile(
      path.join(repoRoot, 'validation/evidence/live-azure-surfaces.dry-run.local.json'),
      `${JSON.stringify({ plan, evidence }, null, 2)}\n`,
      'utf8'
    );
    log(`Dry-run plan: ${plan.caseCount} cases; suite ${SUITE_VERSION}; commit ${testedCommitHashPrefix || 'unset'}`);
    if (flags.renderPlan) {
      console.log(JSON.stringify(plan, null, 2));
    }
    return evidence;
  }

  const subscriptionId = resolveSubscriptionId(env, runner);
  const { location, resourceGroup: sharedResourceGroup } = requiredEnv({ ...env, AZURE_SUBSCRIPTION_ID: subscriptionId });

  const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
  if (!existsSync(cliPath)) {
    throw new Error(`Missing CLI bundle at ${cliPath}; run npm run build first`);
  }

  az(runner, ['account', 'set', '--subscription', subscriptionId]);
  az(runner, ['account', 'show']);

  const resumeSuffix = String(env.AZURE_LIVE_RESUME_SUFFIX ?? '').trim();
  const resumeMarker = String(env.AZURE_LIVE_RESUME_MARKER ?? '').trim();
  if (Boolean(resumeSuffix) !== Boolean(resumeMarker)) {
    throw new Error('AZURE_LIVE_RESUME_SUFFIX and AZURE_LIVE_RESUME_MARKER must be set together');
  }
  const persistentSuffix = String(env.AZURE_LIVE_PERSISTENT_SUFFIX ?? '').trim();
  if (flags.keepAlive) {
    if (!/^[0-9a-f]{4,8}$/.test(persistentSuffix)) {
      throw new Error('--keep-alive requires AZURE_LIVE_PERSISTENT_SUFFIX (4-8 lowercase hex chars) for stable resource names');
    }
    if (flags.teardown) {
      throw new Error('--keep-alive and --teardown are mutually exclusive; tear persistent stacks down explicitly with --cancel-recover');
    }
  }
  const suffix = resumeSuffix || (flags.keepAlive ? persistentSuffix : randomBytes(4).toString('hex'));
  const runMarker = resumeMarker || (flags.keepAlive ? `persistent-${suffix}` : `run-${now()}-${suffix}`);
  const resourceGroup = sharedResourceGroup || `postman-azure-spec-live-${suffix}`;
  const ownsResourceGroup = !sharedResourceGroup;
  const manifest = buildManifestNames({
    suffix,
    runMarker,
    subscriptionId,
    resourceGroup,
    ownsResourceGroup,
    provisionFlags
  });

  let provisioned = Boolean(resumeSuffix) || flags.cancelRecover;
  const capabilities = {
    'apim-multi': { ok: provisionFlags['apim-multi'] !== false },
    'app-service': { ok: provisionFlags['app-service'] !== false }
  };
  let evidence;
  let cleanupFailure;
  let validationFailure;
  let stubUrl = '';
  try {
    if (flags.provision) {
      if (ownsResourceGroup) {
        log(`Creating resource group ${resourceGroup} in ${location}`);
        az(runner, [
          'group',
          'create',
          '--name',
          resourceGroup,
          '--location',
          location,
          '--tags',
          `${RUN_MARKER_TAG}=${runMarker}`
        ]);
      } else {
        log(`Using shared resource group ${resourceGroup} in ${location}`);
        const groupShow = azJson(runner, ['group', 'show', '--name', resourceGroup]);
        const groupSubscription = String(groupShow?.id ?? '').split('/')[2] ?? '';
        if (groupShow?.name !== resourceGroup || groupSubscription !== subscriptionId) {
          throw new Error(`AZURE_RESOURCE_GROUP ${resourceGroup} is not in the selected subscription`);
        }
      }
      provisioned = true;
      await writeFile(
        path.join(repoRoot, 'validation/evidence/live-resource-manifest.local.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
      );

      const liveStackStarted = now();
      let liveStackCurrent = false;
      if (flags.keepAlive) {
        try {
          const existing = azJson(runner, [
            'resource',
            'show',
            '--resource-group',
            resourceGroup,
            '--resource-type',
            'Microsoft.ApiManagement/service',
            '--name',
            manifest.apimName
          ]);
          liveStackCurrent = existing?.tags?.[RESOURCE_RUN_MARKER_TAG] === runMarker;
        } catch (error) {
          if (!isResourceNotFoundError(error)) throw error;
        }
      }
      if (liveStackCurrent) {
        log('Persistent live stack already provisioned; skipping live-stack.bicep deploy');
      } else {
        log('Deploying live-stack.bicep (APIM Consumption + App Service + optional multi-API)');
        az(runner, [
          'deployment',
          'group',
          'create',
          '--name',
          manifest.deploymentName,
          '--resource-group',
          resourceGroup,
          '--template-file',
          'validation/fixtures/azure/live-stack.bicep',
          '--parameters',
          `runMarker=${runMarker}`,
          `apimName=${manifest.apimName}`,
          `appServicePlanName=${manifest.planName}`,
          `siteName=${manifest.siteName}`,
          `repoSlug=${manifest.repoSlug}`,
          `provisionMultiApi=${provisionFlags['apim-multi'] ? 'true' : 'false'}`
        ]);
      }
      recordManifestResource(manifest, { type: 'Microsoft.ApiManagement/service', name: manifest.apimName });
      recordManifestResource(manifest, { type: 'Microsoft.Web/serverfarms', name: manifest.planName });
      recordManifestResource(manifest, { type: 'Microsoft.Web/sites', name: manifest.siteName });
      phases.push({ name: 'live-stack-deploy', durationMs: now() - liveStackStarted });

      const siteHostname = `${manifest.siteName}.azurewebsites.net`;
      let apimExportReadyMs = 0;

      const parallelStarted = now();
      log('Starting parallel provision units (stub deploy, optional APIM APIs, API Center, Service Bus, APIM export poll)');
      const parallelUnits = [
        {
          name: 'stub-deploy',
          fatal: true,
          run: async () => {
            if (liveStackCurrent) {
              const persistentStubUrl = `https://${siteHostname}/openapi.json`;
              const healthy = await waitForStubHealth({
                url: `https://${siteHostname}/health`,
                timeoutMs: CUSTOM_CONNECTOR_TIMEOUT_MS,
                intervalMs: STUB_HEALTH_POLL_INTERVAL_MS,
                fetchImpl,
                now,
                sleep,
                log
              });
              if (healthy) {
                stubUrl = persistentStubUrl;
                log('Persistent App Service stub is healthy; skipping zip deploy');
                return;
              }
            }
            log('Deploying App Service stub zip');
            const stubDir = path.join(repoRoot, 'validation/fixtures/azure/app-service-stub');
            const zipDir = await mkdtemp(path.join(os.tmpdir(), 'az-stub-zip-'));
            const zipPath = path.join(zipDir, 'stub.zip');
            await asyncRunner('zip', [
              '-j',
              zipPath,
              path.join(stubDir, 'package.json'),
              path.join(stubDir, 'server.mjs'),
              path.join(stubDir, 'openapi.json')
            ]);
            await azAsync(asyncRunner, [
              'webapp',
              'deploy',
              '--resource-group',
              resourceGroup,
              '--name',
              manifest.siteName,
              '--src-path',
              zipPath,
              '--type',
              'zip'
            ]);
            await rm(zipDir, { recursive: true, force: true });

            const site = await azJsonAsync(asyncRunner, [
              'webapp',
              'show',
              '--resource-group',
              resourceGroup,
              '--name',
              manifest.siteName
            ]);
            const host = String(site?.defaultHostName || siteHostname).trim();
            stubUrl = `https://${host}/openapi.json`;
            // Public apiDefinition.url only — no secret query parameters.
            log('Setting siteConfig.apiDefinition.url');
            await azAsync(asyncRunner, [
              'rest',
              '--method',
              'patch',
              '--url',
              `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${manifest.siteName}/config/web?api-version=2023-12-01`,
              '--body',
              JSON.stringify({ properties: { apiDefinition: { url: stubUrl } } })
            ]);
          }
        },
        {
          name: 'optional-apim-apis',
          fatal: false,
          run: () =>
            provisionOptionalApimApis({
              runner: asyncRunner,
              log,
              manifest,
              subscriptionId,
              provisionFlags,
              capabilities
            })
        },
        {
          name: 'custom-connector',
          fatal: false,
          run: () =>
            provisionCustomConnectorBounded({
              asyncRunner,
              log,
              manifest,
              subscriptionId,
              location,
              provisionFlags,
              capabilities,
              siteHostname
            })
        },
        {
          name: 'api-center',
          fatal: false,
          run: async () => {
            if (provisionFlags['api-center']) {
              await provisionApiCenter({
                runner: asyncRunner,
                log,
                manifest,
                subscriptionId,
                capabilities
              });
            } else {
              capabilities['api-center'] = { ok: false, reasonCode: 'cost-guard-blocked' };
            }
          }
        },
        {
          name: 'service-bus',
          fatal: false,
          run: () =>
            provisionServiceBusIfGuarded({
              runner: asyncRunner,
              log,
              manifest,
              subscriptionId,
              provisionFlags,
              capabilities
            })
        },
        {
          name: 'apim-export-ready',
          fatal: true,
          run: async () => {
            const exportStarted = now();
            log('Waiting for APIM export availability');
            const deadline = now() + APIM_READY_TIMEOUT_MS;
            let ready = false;
            let lastProbeError = '';
            for (;;) {
              try {
                const exportProbe = await azJsonAsync(asyncRunner, [
                  'rest',
                  '--method',
                  'get',
                  '--url',
                  `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${manifest.apimName}/apis/payments-live?export=true&format=openapi%2Bjson-link&api-version=2024-05-01`
                ]);
                if (exportProbe?.link || exportProbe?.value?.link || exportProbe?.properties?.value?.link) {
                  ready = true;
                  break;
                }
                lastProbeError = 'export response contained no download link';
              } catch (error) {
                lastProbeError = redactSecrets(error instanceof Error ? error.message : String(error));
                if (classifyProbeError(lastProbeError) === 'fatal') {
                  throw new Error(`APIM export probe failed with a non-retryable error: ${lastProbeError}`);
                }
                log(`APIM export probe not ready yet: ${lastProbeError}`);
              }
              if (now() >= deadline) break;
              await sleep(APIM_POLL_INTERVAL_MS);
            }
            apimExportReadyMs = now() - exportStarted;
            if (!ready) {
              throw new Error(
                `APIM export did not become available within the ${APIM_READY_TIMEOUT_MS / 60000}-minute readiness ceiling` +
                  (lastProbeError ? `; last probe error: ${lastProbeError}` : '')
              );
            }
          }
        }
      ];

      const settled = await Promise.allSettled(parallelUnits.map((unit) => unit.run()));
      phases.push({ name: 'parallel-provision', durationMs: now() - parallelStarted });
      phases.push({ name: 'apim-export-ready', durationMs: apimExportReadyMs });

      let firstFatal;
      for (let i = 0; i < settled.length; i += 1) {
        const outcome = settled[i];
        const unit = parallelUnits[i];
        if (outcome.status === 'rejected') {
          log(
            `Parallel provision unit ${unit.name} failed: ${redactSecrets(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason))}`
          );
          if (unit.fatal && !firstFatal) {
            firstFatal = outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
          }
        }
      }
      if (firstFatal) throw firstFatal;

      if (!stubUrl) {
        stubUrl = `https://${siteHostname}/openapi.json`;
      }
      const webhookEndpointUrl = stubUrl.replace(/openapi\.json$/, 'health');

      const extendedStarted = now();
      if (
        provisionFlags['logic-app'] ||
        provisionFlags['template-spec'] ||
        provisionFlags['event-grid'] ||
        provisionFlags['function-app']
      ) {
        const healthOk = await waitForStubHealth({
          url: webhookEndpointUrl,
          timeoutMs: STUB_HEALTH_TIMEOUT_MS,
          intervalMs: STUB_HEALTH_POLL_INTERVAL_MS,
          fetchImpl,
          now,
          sleep,
          log
        });
        if (!healthOk) {
          const reasonCode = 'capability-absent';
          for (const flag of ['logic-app', 'template-spec', 'event-grid', 'function-app']) {
            if (provisionFlags[flag] && !capabilities[flag]?.ok) {
              capabilities[flag] = { ok: false, reasonCode };
            }
          }
          log(`Stub health gate failed; skipping extended-stack deploy (${reasonCode})`);
        } else {
          try {
            const resources = [
              ['logic-app', 'logicAppName', 'Microsoft.Logic/workflows'],
              ['template-spec', 'templateSpecName', 'Microsoft.Resources/templateSpecs'],
              ['event-grid', 'eventGridTopicName', 'Microsoft.EventGrid/topics'],
              ['function-app', 'functionAppName', 'Microsoft.Web/sites']
            ];
            let extendedStackCurrent = flags.keepAlive;
            if (extendedStackCurrent) {
              for (const [flag, key, type] of resources) {
                if (!provisionFlags[flag]) continue;
                try {
                  const existing = await azJsonAsync(
                    asyncRunner,
                    [
                      'resource',
                      'show',
                      '--resource-group',
                      resourceGroup,
                      '--resource-type',
                      type,
                      '--name',
                      manifest[key]
                    ],
                    { timeout: CUSTOM_CONNECTOR_TIMEOUT_MS }
                  );
                  if (existing?.tags?.[RESOURCE_RUN_MARKER_TAG] !== runMarker) {
                    extendedStackCurrent = false;
                    break;
                  }
                } catch {
                  extendedStackCurrent = false;
                  break;
                }
              }
            }

            if (extendedStackCurrent) {
              log('Persistent extended stack already provisioned; skipping extended-stack.bicep deploy');
            } else {
              log('Deploying bounded extended-stack.bicep (logic/templatespec/eventgrid/functions)');
              const plan = await azJsonAsync(
                asyncRunner,
                [
                  'resource',
                  'show',
                  '--resource-group',
                  resourceGroup,
                  '--resource-type',
                  'Microsoft.Web/serverfarms',
                  '--name',
                  manifest.planName
                ],
                { timeout: CUSTOM_CONNECTOR_TIMEOUT_MS }
              );
              await azAsync(
                asyncRunner,
                [
                  'deployment',
                  'group',
                  'create',
                  '--name',
                  manifest.extendedDeploymentName,
                  '--resource-group',
                  resourceGroup,
                  '--template-file',
                  'validation/fixtures/azure/extended-stack.bicep',
                  '--parameters',
                  `runMarker=${runMarker}`,
                  `logicAppName=${manifest.logicAppName}`,
                  `templateSpecName=${manifest.templateSpecName}`,
                  `eventGridTopicName=${manifest.eventGridTopicName}`,
                  `eventGridSubName=${manifest.eventGridSubName}`,
                  `webhookEndpointUrl=${webhookEndpointUrl}`,
                  `functionAppName=${manifest.functionAppName}`,
                  `appServicePlanId=${plan?.id ?? ''}`,
                  `provisionLogicApp=${provisionFlags['logic-app'] ? 'true' : 'false'}`,
                  `provisionTemplateSpec=${provisionFlags['template-spec'] ? 'true' : 'false'}`,
                  `provisionEventGrid=${provisionFlags['event-grid'] ? 'true' : 'false'}`,
                  `provisionFunctionApp=${provisionFlags['function-app'] ? 'true' : 'false'}`
                ],
                { timeout: EXTENDED_DEPLOYMENT_TIMEOUT_MS }
              );
            }
            for (const [flag, key, type] of resources) {
              if (provisionFlags[flag]) {
                capabilities[flag] = { ok: true };
                recordManifestResource(manifest, { type, name: manifest[key] });
              } else {
                capabilities[flag] = { ok: false, reasonCode: 'cost-guard-blocked' };
              }
            }
          } catch (error) {
            const reasonCode = capabilityReasonFromError(error);
            for (const flag of ['logic-app', 'template-spec', 'event-grid', 'function-app']) {
              if (provisionFlags[flag] && !capabilities[flag]?.ok) {
                capabilities[flag] = { ok: false, reasonCode };
              }
            }
            log(
              `Extended stack partially blocked (${reasonCode}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`
            );
          }
        }
      }
      phases.push({ name: 'extended-stack', durationMs: now() - extendedStarted });

      await writeFile(
        path.join(repoRoot, 'validation/evidence/live-resource-manifest.local.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
      );
    } else if (flags.cancelRecover) {
      const localManifestPath = path.join(repoRoot, 'validation/evidence/live-resource-manifest.local.json');
      if (existsSync(localManifestPath)) {
        Object.assign(manifest, JSON.parse(readFileSync(localManifestPath, 'utf8')));
      }
      provisioned = true;
      log(`Cancel-recover mode: will teardown run marker ${manifest.runMarker}`);
    }

    const caseStarted = now();
    const results = flags.cancelRecover
      ? []
      : await runCases({ runner, log, manifest, subscriptionId, cliPath, capabilities, now, caseFilter });
    phases.push({ name: 'case-matrix', durationMs: now() - caseStarted });
    evidence = buildEvidence(results, { testedCommitHashPrefix, phases: [...phases] });
    if (!flags.cancelRecover) {
      await writeFile(
        path.join(repoRoot, 'validation/evidence/live-azure-surfaces.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      );
      log(
        `Live validation: ${evidence.passed} pass / ${evidence.failed} fail / ${evidence.requiresCapability} requires-capability / ${evidence.localOnly} local-only (${evidence.cases} cases)`
      );
      if (evidence.failed > 0) {
        throw new Error(`${evidence.failed} live validation case(s) failed`);
      }
    }
  } catch (error) {
    validationFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (flags.keepAlive && provisioned) {
      log(`Keep-alive: leaving persistent stack ${manifest.runMarker} running (no teardown)`);
    }
    if (flags.teardown && !flags.keepAlive && provisioned) {
      const teardownStarted = now();
      if (ownsResourceGroup) {
        try {
          await teardownDedicatedResourceGroup({ runner, log, manifest, subscriptionId, now, sleep });
        } catch (error) {
          cleanupFailure = error instanceof Error ? error : new Error(String(error));
          log(`Dedicated-group teardown failure: ${redactSecrets(cleanupFailure.message)}`);
        }
      } else {
        try {
          await teardownSharedGroupResources({ runner, log, manifest, subscriptionId, now, sleep });
        } catch (error) {
          cleanupFailure = error instanceof Error ? error : new Error(String(error));
          log(`Shared-group teardown failure: ${redactSecrets(cleanupFailure.message)}`);
        }
      }
      phases.push({ name: 'teardown', durationMs: now() - teardownStarted });
    }
  }

  // Always publish sanitized evidence on failure paths (never claim unrun passes).
  if (!evidence) {
    evidence = buildEvidence(
      [toEvidenceResult('runner', 'fail', { reasonCode: 'cli-failed' })],
      { testedCommitHashPrefix, phases: phases.length > 0 ? [...phases] : undefined }
    );
  } else if (phases.length > 0 && !evidence.phases) {
    evidence = buildEvidence(evidence.results, {
      testedCommitHashPrefix: evidence.testedCommitHashPrefix,
      suiteVersion: evidence.suiteVersion,
      phases: [...phases]
    });
  } else if (phases.some((phase) => phase.name === 'teardown') && Array.isArray(evidence.phases)) {
    // Rebuild so teardown duration captured in finally is included.
    evidence = buildEvidence(evidence.results, {
      testedCommitHashPrefix: evidence.testedCommitHashPrefix,
      suiteVersion: evidence.suiteVersion,
      phases: [...phases]
    });
  }
  if (!flags.cancelRecover && !flags.dryRun) {
    await writeFile(
      path.join(repoRoot, 'validation/evidence/live-azure-surfaces.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8'
    );
  }
  if (cleanupFailure) throw cleanupFailure;
  if (validationFailure) throw validationFailure;
  return evidence;
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = path.resolve(new URL(import.meta.url).pathname);
if (entrypoint === here) {
  runLiveValidation().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
